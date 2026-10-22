import { z } from "zod";
import { describeError } from "../events.ts";
import { defineTool, type ToolDefinition, type ToolOutcome } from "../tools/types.ts";
import { MEMORY_TYPES, type MemoryPort } from "./port.ts";

export const MEMORY_TOOL = "memory";
/** Bytes of recent memory a session starts with. */
export const CONTEXT_BYTES = 2048;
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

export function createMemoryTool(memory: MemoryPort): ToolDefinition {
	return defineTool({
		name: MEMORY_TOOL,
		description: [
			`Long-term memory of project ${memory.project}, shared across sessions.`,
			"search (query): find earlier decisions, fixes and discoveries. get (id): read one in full.",
			"save (title, type, content, topicKey?): keep something worth knowing next time, as **What** / **Why** / **Where** / **Learned**. The same topicKey updates that memory instead of adding one. Never save secrets.",
		].join("\n"),
		inputShape: {
			action: z.enum(["search", "get", "save"]),
			query: z.string().optional().describe("search"),
			limit: z.number().int().min(1).max(SEARCH_LIMIT).optional().describe(`search: 1 to ${SEARCH_LIMIT}`),
			id: z.number().int().optional().describe("get"),
			title: z.string().optional().describe("save: short and searchable"),
			type: z.enum(MEMORY_TYPES).optional().describe("save"),
			content: z.string().optional().describe("save"),
			topicKey: z.string().optional().describe("save: stable key for something that evolves, like project/topic"),
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
						const { id } = await memory.save({
							title: input.title,
							type: input.type,
							content: input.content,
							...(input.topicKey?.trim() ? { topicKey: input.topicKey.trim() } : {}),
						});
						return done(`Saved memory #${id}.`);
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
