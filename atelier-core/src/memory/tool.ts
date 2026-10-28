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
	// No word boundary at the end: a key joined with the next words, or followed by `_` or more of a word, is still one.
	{ name: "an npm token", pattern: /\bnpm_[A-Za-z0-9]{36,}/ },
	{ name: "a Stripe live key", pattern: /\b[rs]k_live_[A-Za-z0-9]{24,}/ },
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
	// The whole value of a header named *Authorization (Proxy-, X-...), whatever its scheme. A quoted value ends at
	// its closing quote; a header inside quotes (curl's -H '...' or -H "..."), at the quote that closes the header;
	// any other value, a quoted name's too, at the end of the line, quotes inside it included. Backslash escapes stay inside.
	/\b((?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*")(?:\\.|[^"\\\n])*/gi,
	/\b((?:Proxy-)?Authorization["']?[ \t]*[:=][ \t]*')(?:\\.|[^'\\\n])*/gi,
	/(?<=')([A-Za-z0-9_-]*Authorization[ \t]*[:=][ \t]*)(?![ \t'])(?:\\.|[^'\\\n])*/gi,
	/(?<=")([A-Za-z0-9_-]*Authorization[ \t]*[:=][ \t]*)(?![ \t"])(?:\\.|[^"\\\n])*/gi,
	// A quoted name ("Authorization": ...) with an unquoted value: the quote closes the name, not the value. A JSON
	// null, boolean or number ends where it ends, before a ',', '}' or ']', so the rest of a one-line object stays.
	/(?<=['"])([A-Za-z0-9_-]*Authorization["'][ \t]*[:=][ \t]*)(?![ \t"'])(?:(?:null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[ \t]*(?:[,}\]\n]|$))|[^\n]*)/gi,
	/(?<![-'"A-Za-z0-9_])([A-Za-z0-9_-]*Authorization["']?[ \t]*[:=][ \t]*)(?![ \t"'])(?:(?:null|true|false|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=[ \t]*(?:[,}\]\n]|$))|[^\n]*)/gi,
	/\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
];

/** A curl or wget command's name, also at the end of a path (`/usr/bin/curl`). */
const PASSWORD_COMMAND = /(?<![\w.-])(curl|wget)(?:\.exe)?(?![\w.-])/g;
/** Characters that end a command where no quote holds them. */
const COMMAND_END = ";&|\n`()";
/** curl's options whose value is `user:password`, alone (the value is the next word) or with it attached. */
const CURL_USER = /^(?:(-u|-U|--user|--proxy-user)$|-[uU]|--user=|--proxy-user=)/;
/** wget's options whose value is a password, alone or with `=value`. */
const WGET_PASSWORD = /^(?:--(?:(?:http|ftp|proxy)-)?passw(?:or)?d)(=|$)/;

/**
 * The next shell word of a command from `from`, past blanks and line continuations: where it starts and ends, with
 * its quotes (a quote left open runs to the end of the text). Undefined where the command ends.
 */
function shellWord(text: string, from: number): { start: number; end: number } | undefined {
	let i = from;
	while (text[i] === " " || text[i] === "\t" || (text[i] === "\\" && text[i + 1] === "\n"))
		i += text[i] === "\\" ? 2 : 1;
	if (i >= text.length || COMMAND_END.includes(text[i] as string)) return undefined;
	const start = i;
	while (i < text.length) {
		const c = text[i] as string;
		if (c === " " || c === "\t" || COMMAND_END.includes(c) || (c === "\\" && text[i + 1] === "\n")) break;
		if (c === "\\") i += 2;
		else if (c === "'" || c === '"') i = pastQuote(text, c, i + 1);
		else i++;
	}
	return { start, end: Math.min(i, text.length) };
}

/** Just past the first `quote` from `from` (a backslash escapes inside double quotes), or the text's end. */
function pastQuote(text: string, quote: string, from: number): number {
	for (let i = from; i < text.length; i++) {
		if (quote === '"' && text[i] === "\\") i++;
		else if (text[i] === quote) return i + 1;
	}
	return text.length;
}

/**
 * Where the password of a `user:password` word between `start` and `end` lies: after the first ':', to the word's
 * end, or to the quote that closes the word when the ':' is inside quotes that close it (`'ana:p w'`).
 */
function passwordAfterColon(text: string, start: number, end: number): [number, number] | undefined {
	let quote = "";
	for (let i = start; i < end; i++) {
		const c = text[i];
		if (c === "\\" && quote !== "'") i++;
		else if (quote === "" && (c === "'" || c === '"')) quote = c;
		else if (c === quote) quote = "";
		else if (c === ":") {
			const closed = quote !== "" && text[end - 1] === quote && pastQuote(text, quote, i + 1) === end;
			const last = closed ? end - 1 : end;
			return i + 1 < last ? [i + 1, last] : undefined;
		}
	}
	return undefined;
}

/** Where the passwords of one curl or wget command lie, from its first word at `from` to where the command ends. */
function commandPasswords(text: string, command: string, from: number): { spans: [number, number][]; end: number } {
	const spans: [number, number][] = [];
	let valueNext: "user" | "password" | undefined;
	let end = from;
	for (let word = shellWord(text, from); word; word = shellWord(text, word.end)) {
		end = word.end;
		const raw = text.slice(word.start, word.end);
		// The word after an option that takes its value apart: a password whole, or a user:password.
		const valued = valueNext;
		valueNext = undefined;
		if (valued === "password") spans.push([word.start, word.end]);
		const found = valued === "user" ? passwordAfterColon(text, word.start, word.end) : undefined;
		if (found) spans.push(found);
		if (valued) continue;
		const user = command === "curl" ? CURL_USER.exec(raw) : null;
		const password = command === "wget" ? WGET_PASSWORD.exec(raw) : null;
		if (user?.[1]) valueNext = "user";
		else if (user) {
			const found = passwordAfterColon(text, word.start + user[0].length, word.end);
			if (found) spans.push(found);
		} else if (password?.[1] === "") valueNext = "password";
		else if (password && word.start + password[0].length < word.end) {
			spans.push([word.start + password[0].length, word.end]);
		}
	}
	return { spans, end };
}

/**
 * The password of curl's `-u` / `--user` and `-U` / `--proxy-user` `user:password` and of wget's `--password` (and
 * its `--http-`, `--ftp-` and `--proxy-` forms) replaced by `[REDACTED]`, read as the shell reads the command's words:
 * quoted, escaped or attached to the option. Another command's `-u` is left alone. Each command is read once and the
 * search resumes past it, so the work stays linear on any text.
 */
function maskCommandPasswords(text: string): string {
	let masked = "";
	let last = 0;
	PASSWORD_COMMAND.lastIndex = 0;
	for (let command = PASSWORD_COMMAND.exec(text); command !== null; command = PASSWORD_COMMAND.exec(text)) {
		const { spans, end } = commandPasswords(text, command[1] as string, PASSWORD_COMMAND.lastIndex);
		PASSWORD_COMMAND.lastIndex = Math.max(PASSWORD_COMMAND.lastIndex, end);
		for (const [start, stop] of spans) {
			masked += `${text.slice(last, start)}[REDACTED]`;
			last = stop;
		}
	}
	return masked + text.slice(last);
}

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
	return maskAssigned(maskUrlPasswords(maskCommandPasswords(valued)));
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
