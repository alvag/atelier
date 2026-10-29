import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { describeError } from "../events.ts";
import { VERSION } from "../version.ts";
import {
	type MemoryEntry,
	MemoryError,
	type MemoryHit,
	type MemoryMatchMode,
	type MemoryPort,
	MemoryUnavailableError,
	MemoryUncertainError,
	type NewMemory,
	type SavedMemory,
} from "./port.ts";

/**
 * The only file that knows Engram. It runs `engram mcp` (MCP over stdio) from
 * the session folder, so Engram resolves the project from it, and closes it
 * with the session. Engram's own HTTP session mode is not used: its contract
 * is Pi's plugin runtime, not a general one.
 */

export const ENGRAM_MIN_VERSION = "3.4.0";
const REQUIRED_TOOLS = [
	"mem_current_project",
	"mem_context",
	"mem_search",
	"mem_get_observation",
	"mem_save",
	"mem_session_summary",
];
/** Variables that point a client at another Engram server; this adapter owns its own process. */
const SERVER_VARIABLES = ["ENGRAM_URL", "ENGRAM_PORT", "ENGRAM_SOCKET"];
const CALL_TIMEOUT_MS = 15_000;
/** A prompt save holds the end of its turn, so it waits less; a lost one is not retried anyway. */
const PROMPT_TIMEOUT_MS = 5_000;
const PREVIEW_CHARS = 200;
/** Metadata lines Engram appends after an observation's content. */
const METADATA =
	/^(Session|Project|Scope|Topic|Duplicates|Revisions|Created|Updated|Pinned|State|Review after|Sync id): /;

export interface EngramOptions {
	/** Session folder: Engram resolves the project from it. */
	cwd: string;
	/** Environment for Engram; defaults to process.env. Server variables are removed. */
	env?: Record<string, string | undefined>;
	command?: string;
	/** False keeps the user's prompts out of Engram; on by default, when Engram has mem_save_prompt. */
	prompts?: boolean;
	/** What the session says in its first turn about this memory, such as a setting that could not be used. */
	warnings?: readonly string[];
}

/** The optional tools this Engram has and the user allows. */
interface EngramFeatures {
	matchMode?: boolean;
	prompts?: boolean;
	sessions?: boolean;
	warnings?: readonly string[];
}

const projectResponse = z.object({ project: z.string().min(1) });
const saveResponse = z.object({ id: z.number().int(), candidate_detection_status: z.string().optional() });
/** Engram saved the memory but could not look for the ones it may conflict with; saving again would not help. */
const DETECTION_INCOMPLETE =
	"conflict detection did not finish, so this memory may duplicate or contradict an existing one; search for it before relying on it.";
const searchResponse = z.object({
	results: z
		.array(z.object({ id: z.number().int(), title: z.string(), type: z.string(), preview: z.string().optional() }))
		.nullable()
		.optional(),
});
const resultResponse = z.object({ result: z.string() });

export async function connectEngram(options: EngramOptions): Promise<EngramMemory> {
	const command = options.command ?? "engram";
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(options.env ?? process.env))
		if (value !== undefined && !SERVER_VARIABLES.includes(key)) env[key] = value;

	const version = await engramVersion(command, env);
	if (compareVersions(version, ENGRAM_MIN_VERSION) < 0)
		throw new MemoryUnavailableError(`Engram ${version} is too old; Atelier needs ${ENGRAM_MIN_VERSION} or newer.`);

	const client = new Client({ name: "atelier", version: VERSION });
	const transport = new StdioClientTransport({ command, args: ["mcp"], env, cwd: options.cwd, stderr: "ignore" });
	try {
		await client.connect(transport);
		const listed = (await client.listTools()).tools;
		const tools = new Set(listed.map((tool) => tool.name));
		const searchSchema = listed.find((tool) => tool.name === "mem_search")?.inputSchema;
		const missing = REQUIRED_TOOLS.filter((tool) => !tools.has(tool));
		if (missing.length > 0) throw new MemoryUnavailableError(`Engram ${version} lacks ${missing.join(", ")}.`);
		const memory = new EngramMemory(client, "");
		const { project } = await memory.call("mem_current_project", {}, projectResponse);
		return new EngramMemory(client, project, {
			matchMode: Object.hasOwn(searchSchema?.properties ?? {}, "match_mode"),
			prompts: options.prompts !== false && tools.has("mem_save_prompt"),
			sessions: tools.has("mem_session_start") && tools.has("mem_session_end"),
			warnings: options.warnings ?? [],
		});
	} catch (error) {
		await client.close().catch(() => {});
		if (error instanceof MemoryUnavailableError) throw error;
		throw new MemoryUnavailableError(`Engram did not start: ${describeError(error)}`);
	}
}

export class EngramMemory implements MemoryPort {
	readonly project: string;
	readonly warnings: readonly string[];
	readonly #client: Client;
	readonly #features: EngramFeatures;
	/** The session Engram registered; every write names it. */
	#sessionId: string | undefined;

	constructor(client: Client, project: string, features: EngramFeatures = {}) {
		this.#client = client;
		this.project = project;
		this.#features = features;
		this.warnings = features.warnings ?? [];
	}

	async context(maxBytes: number): Promise<string> {
		const { result } = await this.call("mem_context", { compact: true, max_bytes: maxBytes }, resultResponse);
		return headBytes(result, maxBytes);
	}

	async search(query: string, limit: number, matchMode: MemoryMatchMode = "all"): Promise<MemoryHit[]> {
		if (matchMode === "any" && !this.#features.matchMode)
			throw new MemoryError("This Engram does not support match_mode: any; update it to use broader search.");
		const response = await this.call(
			"mem_search",
			{
				query,
				limit,
				response_format: "compact",
				...(this.#features.matchMode ? { match_mode: matchMode } : {}),
			},
			searchResponse,
		);
		return (response.results ?? []).map((hit) => ({
			id: hit.id,
			title: hit.title,
			type: hit.type,
			preview: (hit.preview ?? "").slice(0, PREVIEW_CHARS),
		}));
	}

	async get(id: number): Promise<MemoryEntry | undefined> {
		const response = await this.#raw("mem_get_observation", { id });
		if (response.isError) {
			if (/not found/i.test(response.text)) return undefined;
			throw new MemoryError(`Engram: ${response.text}`);
		}
		const { result } = parse(response.text, resultResponse, "mem_get_observation");
		const entry = parseObservationText(result);
		if (!entry || entry.id !== id)
			throw new MemoryError("Engram answered mem_get_observation in an unexpected format.");
		return entry;
	}

	async save(entry: NewMemory): Promise<SavedMemory> {
		const response = await this.call(
			"mem_save",
			{
				title: entry.title,
				type: entry.type,
				content: entry.content,
				// Atelier never sends the user's prompt along with a memory.
				capture_prompt: false,
				...(entry.topicKey === undefined ? {} : { topic_key: entry.topicKey }),
				...this.#session(),
			},
			saveResponse,
		);
		if (response.candidate_detection_status === "incomplete") return { id: response.id, warning: DETECTION_INCOMPLETE };
		return { id: response.id };
	}

	async summary(text: string): Promise<void> {
		await this.call("mem_session_summary", { content: text, ...this.#session() }, z.object({}).passthrough());
	}

	async savePrompt(text: string): Promise<void> {
		if (!this.#features.prompts) return;
		await this.call(
			"mem_save_prompt",
			{ content: text, ...this.#session() },
			z.object({}).passthrough(),
			PROMPT_TIMEOUT_MS,
		);
	}

	async begin(id: string, directory: string): Promise<void> {
		if (!this.#features.sessions) return;
		await this.call("mem_session_start", { id, directory }, z.object({}).passthrough());
		this.#sessionId = id;
	}

	async end(): Promise<void> {
		const id = this.#sessionId;
		if (id === undefined) return;
		this.#sessionId = undefined;
		await this.call("mem_session_end", { id }, z.object({}).passthrough());
	}

	#session(): { session_id?: string } {
		return this.#sessionId === undefined ? {} : { session_id: this.#sessionId };
	}

	/** Closing stdin ends the Engram process. */
	async close(): Promise<void> {
		await this.#client.close();
	}

	/** Calls a tool and validates its JSON answer; any surprise is a MemoryError, never a guess. */
	async call<T>(
		name: string,
		args: Record<string, unknown>,
		schema: z.ZodType<T>,
		timeout = CALL_TIMEOUT_MS,
	): Promise<T> {
		const response = await this.#raw(name, args, timeout);
		if (response.isError) throw new MemoryError(`Engram ${name}: ${response.text}`);
		return parse(response.text, schema, name);
	}

	async #raw(
		name: string,
		args: Record<string, unknown>,
		timeout = CALL_TIMEOUT_MS,
	): Promise<{ isError: boolean; text: string }> {
		let result: Awaited<ReturnType<Client["callTool"]>>;
		try {
			result = await this.#client.callTool({ name, arguments: args }, undefined, { timeout });
		} catch (error) {
			// Never a crash of the caller. Engram refusing the request is a clear failure; a timeout, a dead process, a cut
			// connection or an internal error leave unknown whether the call landed.
			const message = `Engram ${name} failed: ${describeError(error)}`;
			throw isRefusal(error) ? new MemoryError(message) : new MemoryUncertainError(message);
		}
		const content = Array.isArray(result.content) ? result.content : [];
		const first = content[0] as { type?: string; text?: string } | undefined;
		return { isError: result.isError === true, text: first?.type === "text" ? (first.text ?? "") : "" };
	}
}

/** Protocol errors that leave unknown whether the call landed: no answer came, or Engram failed while handling it. */
const UNCERTAIN_CODES: readonly number[] = [
	ErrorCode.RequestTimeout,
	ErrorCode.ConnectionClosed,
	ErrorCode.InternalError,
];

/** An answer from Engram that refuses the request (invalid params, unknown tool...), so nothing was done. */
function isRefusal(error: unknown): boolean {
	return error instanceof McpError && !UNCERTAIN_CODES.includes(error.code);
}

/**
 * Reads "#<id> [<type>] <title>", the content, then Engram's metadata block, read
 * from the end up to its "Session:" line and no further: content that looks like
 * metadata stays content. A block without that line is not trusted (undefined).
 */
export function parseObservationText(text: string): MemoryEntry | undefined {
	const lines = text.split("\n");
	const header = /^#(\d+) \[([^\]]+)\] (.*)$/.exec(lines[0] ?? "");
	if (!header) return undefined;
	let end = lines.length;
	const metadata: Record<string, string> = {};
	for (;;) {
		const line = end > 1 ? (lines[end - 1] as string) : "";
		if (!METADATA.test(line)) return undefined;
		const colon = line.indexOf(": ");
		metadata[line.slice(0, colon)] = line.slice(colon + 2);
		end--;
		if (line.startsWith("Session: ")) break;
	}
	return {
		id: Number(header[1]),
		type: header[2] as string,
		title: header[3] as string,
		content: lines.slice(1, end).join("\n"),
		...(metadata.Topic === undefined ? {} : { topicKey: metadata.Topic }),
	};
}

function parse<T>(text: string, schema: z.ZodType<T>, tool: string): T {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new MemoryError(`Engram answered ${tool} with something that is not JSON: ${text.slice(0, 120)}`);
	}
	const result = schema.safeParse(value);
	if (!result.success) throw new MemoryError(`Engram answered ${tool} in an unexpected format.`);
	return result.data;
}

function engramVersion(command: string, env: Record<string, string>): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(command, ["version"], { env, timeout: 10_000 }, (error, stdout) => {
			if (error) {
				const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
				reject(
					new MemoryUnavailableError(
						missing ? "Engram is not installed (no engram command)." : `engram version failed: ${error.message}`,
					),
				);
				return;
			}
			const version = /(\d+\.\d+\.\d+)/.exec(stdout)?.[1];
			if (!version) reject(new MemoryUnavailableError(`Could not read the Engram version from: ${stdout.trim()}`));
			else resolve(version);
		});
	});
}

function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
}

function headBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text);
	if (buffer.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && ((buffer[end] as number) & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}
