import { z } from "zod";
import { describeError } from "../events.ts";
import { defineTool, type ToolDefinition, type ToolOutcome } from "../tools/types.ts";
import { MEMORY_TYPES, type MemoryPort } from "./port.ts";

export const MEMORY_TOOL = "memory";
/** Bytes of recent memory a session starts with. */
export const CONTEXT_BYTES = 2048;
/** Characters of a user prompt kept in memory. */
export const PROMPT_CHARS = 2000;
const SEARCH_LIMIT = 10;
const ENTRY_CHARS = 8000;

/** Shapes of credentials that must never reach memory. Prose that merely names them does not match. */
const SECRETS: { name: string; pattern: RegExp }[] = [
	{ name: "an Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/ },
	{ name: "an API key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/ },
	{ name: "a GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
	{ name: "a GitHub token", pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
	{ name: "a Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}/ },
	{ name: "an AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
	{ name: "a Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
	{ name: "a private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
];

/**
 * Names the kind of secret found, never the secret itself. It also joins each
 * word with the next two, so a key broken across lines or fields is still found
 * while it keeps the word boundary it starts at.
 */
export function findSecret(text: string): string | undefined {
	const words = text.split(/\s+/).filter((word) => word !== "");
	const joined = words.map((word, i) => word + (words[i + 1] ?? "") + (words[i + 2] ?? ""));
	return SECRETS.find(
		(secret) => secret.pattern.test(text) || joined.some((candidate) => secret.pattern.test(candidate)),
	)?.name;
}

/** A private key block from its BEGIN line through its END line, or to the end of the text when it has none. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/g;

/** Words that make a name's value a credential when one is assigned to it (`DB_PASSWORD=…`, `api_key: …`). */
const SECRET_WORD = /PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL/i;
/**
 * A name followed by `=` or `:`. The lookbehind starts it only where a run of name characters starts, and the
 * lookahead with its backreference takes the run whole, without giving characters back: linear on any text.
 */
const ASSIGNMENT = /(?<![A-Za-z0-9_.-])(?=([A-Za-z0-9_.-]+))\1["']?[ \t]*[:=][ \t]*/g;
/** The value an assignment gives: quoted, or up to a space, a quote, a comma or a semicolon. */
const ASSIGNED_VALUE = /"[^"\n]*"|'[^'\n]*'|[^\s"',;]+/y;

/** The values assigned to names with a secret's word in them, replaced by `[REDACTED]`; the names stay. */
function maskAssigned(text: string): string {
	let masked = "";
	let last = 0;
	for (const assignment of text.matchAll(ASSIGNMENT)) {
		const start = assignment.index + assignment[0].length;
		if (start < last || !SECRET_WORD.test(assignment[1] as string)) continue;
		ASSIGNED_VALUE.lastIndex = start;
		const value = ASSIGNED_VALUE.exec(text);
		if (!value) continue;
		masked += `${text.slice(last, start)}[REDACTED]`;
		last = start + value[0].length;
	}
	return masked + text.slice(last);
}

/** Where a URL's password starts: after `scheme://user:`, only where a scheme can start. */
const URL_USER = /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:/gi;

/**
 * The password of each `scheme://user:password@host` URL replaced by `[REDACTED]`, up to the authority's last '@':
 * one that the next '@' follows without a '/', '?', '#' or space between them still belongs to the password. Each
 * search resumes past what it read, so the work stays linear on any text.
 */
function maskUrlPasswords(text: string): string {
	let masked = "";
	let last = 0;
	URL_USER.lastIndex = 0;
	for (let user = URL_USER.exec(text); user !== null; user = URL_USER.exec(text)) {
		const start = user.index + user[0].length;
		let at = -1;
		let i = start;
		while (i < text.length && !/\s/.test(text[i] as string)) {
			if (text[i] === "@") at = i;
			else if (at !== -1 && "/?#".includes(text[i] as string)) break;
			i++;
		}
		URL_USER.lastIndex = Math.max(URL_USER.lastIndex, at === -1 ? i : at);
		if (at === -1) continue;
		masked += `${text.slice(last, start)}[REDACTED]`;
		last = at;
	}
	return masked + text.slice(last);
}

/** Credentials told by where they stand, not by their shape: group 1 (the name) stays, the value is replaced. */
const VALUE_MASKS: RegExp[] = [
	// The whole value of an Authorization or Proxy-Authorization header, whatever its scheme: up to its closing quote,
	// or to the end of the line (or a quote) when it has none.
	/\b((?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*")[^"\n]*/gi,
	/\b((?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*')[^'\n]*/gi,
	/\b((?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*)(?![ \t"'])[^\n"']+/gi,
	/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
];

/** The private key blocks and the shapes `findSecret` knows, replaced by `[REDACTED]` where they stand whole. */
function maskShapes(text: string): string {
	return SECRETS.reduce(
		(masked, secret) => masked.replace(new RegExp(secret.pattern.source, "g"), "[REDACTED]"),
		text.replace(PRIVATE_KEY_BLOCK, "[REDACTED]"),
	);
}

/** The values the masks tell by where they stand (a header, a secret's name, a URL), replaced by `[REDACTED]`. */
function maskPlaced(text: string): string {
	const valued = VALUE_MASKS.reduce(
		(masked, pattern) => masked.replace(pattern, (_match, name: string) => `${name}[REDACTED]`),
		text,
	);
	return maskAssigned(maskUrlPasswords(valued));
}

/**
 * The text with every credential it can tell replaced by `[REDACTED]`, best effort: a private key whole, body
 * included; the value of an Authorization header, of a bearer token, of a name like `*PASSWORD*`, `*SECRET*` or
 * `*TOKEN*` it is assigned to (an AWS secret access key among them) and of a password in a URL; and the shapes
 * `findSecret` knows. One still found across words is left to `findSecret`.
 */
export function maskSecrets(text: string): string {
	return maskPlaced(maskShapes(text));
}

const MASK = "[REDACTED]";

/**
 * What memory keeps of a prompt: masked whole first, then cut to `PROMPT_CHARS` characters, never inside a mask, so
 * the cut cannot leave part of a credential behind. Undefined when nothing is left, or when a credential is still
 * found across words (then the prompt is not kept at all).
 */
export function promptForMemory(text: string): string | undefined {
	// A key split across words is looked for before the masks by place, which would hide its known prefix.
	const shaped = maskShapes(text);
	if (findSecret(shaped)) return undefined;
	const masked = maskPlaced(shaped);
	if (masked.trim() === "") return undefined;
	const chars = Array.from(masked);
	if (chars.length <= PROMPT_CHARS) return masked;
	let cut = chars.slice(0, PROMPT_CHARS).join("");
	const open = cut.lastIndexOf("[");
	if (open !== -1 && MASK.startsWith(cut.slice(open)) && cut.slice(open) !== MASK) cut = cut.slice(0, open);
	return cut;
}

export function createMemoryTool(memory: MemoryPort): ToolDefinition {
	return defineTool({
		name: MEMORY_TOOL,
		description: [
			`Long-term memory of project ${memory.project}, shared across sessions.`,
			"search (query): find earlier decisions, fixes and discoveries. get (id): read one in full.",
			"save (title, type, content, topicKey?): keep verified knowledge worth knowing next time, one memory per topic, as **What** / **Why** / **Where** / **Learned**. The same topicKey replaces that memory, so keep its still-valid facts. Never save secrets.",
		].join("\n"),
		inputShape: {
			action: z.enum(["search", "get", "save"]),
			query: z.string().optional().describe("search"),
			limit: z.number().int().min(1).max(SEARCH_LIMIT).optional().describe(`search: 1 to ${SEARCH_LIMIT}`),
			id: z.number().int().optional().describe("get"),
			title: z.string().optional().describe("save: short and searchable"),
			type: z.enum(MEMORY_TYPES).optional().describe("save"),
			content: z.string().optional().describe("save"),
			topicKey: z
				.string()
				.optional()
				.describe("save: stable key for one topic, like project/topic; reuse it to update that topic"),
		},
		execute: async (input) => {
			try {
				switch (input.action) {
					case "search": {
						if (!input.query?.trim()) return failed("search needs query.");
						const hits = await memory.search(input.query, input.limit ?? SEARCH_LIMIT);
						if (hits.length === 0) return done(`No memories match "${input.query}".`);
						return done(
							hits.map((hit) => `#${hit.id} [${hit.type}] ${hit.title} — ${oneLine(hit.preview)}`).join("\n"),
						);
					}
					case "get": {
						if (input.id === undefined) return failed("get needs id.");
						const entry = await memory.get(input.id);
						if (!entry) return failed(`No memory #${input.id}.`);
						const head = [`#${entry.id} [${entry.type}] ${entry.title}`];
						if (entry.topicKey) head.push(`Topic: ${entry.topicKey}`);
						const content =
							entry.content.length > ENTRY_CHARS
								? `${entry.content.slice(0, ENTRY_CHARS)}\n[memory truncated at ${ENTRY_CHARS} characters]`
								: entry.content;
						return done(`${head.join("\n")}\n\n${content}`);
					}
					case "save": {
						if (!input.title?.trim() || !input.type || !input.content?.trim())
							return failed("save needs title, type and content.");
						const secret = findSecret(`${input.title}\n${input.content}\n${input.topicKey ?? ""}`);
						if (secret) return failed(`Not saved: it contains what looks like ${secret}. Never save secrets.`);
						const { id, warning } = await memory.save({
							title: input.title,
							type: input.type,
							content: input.content,
							...(input.topicKey?.trim() ? { topicKey: input.topicKey.trim() } : {}),
						});
						// On the first line, so the call's summary shows it to the user too.
						return done(`Saved memory #${id}.${warning === undefined ? "" : ` Warning: ${warning}`}`);
					}
				}
			} catch (error) {
				return failed(`Memory failed: ${describeError(error)}`);
			}
		},
	});
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function done(output: string): ToolOutcome {
	return { ok: true, output, summary: output.split("\n")[0] ?? "", truncated: false };
}

function failed(output: string): ToolOutcome {
	return { ok: false, output, summary: output, truncated: false };
}
