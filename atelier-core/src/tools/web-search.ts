import { z } from "zod";
import { errorMessage, failure } from "./limits.ts";
import { defineTool, type ToolDefinition } from "./types.ts";

export const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const EXA_SEARCH_TOOL = "web_search_exa";
export const SEARCH_TIMEOUT_MS = 30_000;
export const MAX_ANSWER_BYTES = 1024 * 1024;
export const DEFAULT_RESULTS = 5;
export const MAX_RESULTS = 10;
const MAX_SNIPPET_CHARS = 500;
const MAX_TITLE_CHARS = 300;
const MAX_URL_CHARS = 1000;

export interface WebSearchOptions {
	/** The MCP endpoint; tests point it at a local server. */
	endpoint?: string;
	timeoutMs?: number;
}

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

class SearchError extends Error {
	override name = "SearchError";
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The server answers a tools/call as one JSON body or as an SSE stream; either way the reply is one JSON-RPC message. */
function parseRpc(body: string): { result?: unknown; error?: unknown } {
	const candidates = [
		...body.split("\n").flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trim()] : [])),
		body,
	];
	for (const candidate of candidates) {
		try {
			const message = JSON.parse(candidate) as { result?: unknown; error?: unknown } | null;
			if (message && typeof message === "object" && (message.result !== undefined || message.error !== undefined))
				return message;
		} catch {
			// Not JSON: try the next candidate.
		}
	}
	throw new SearchError("the answer was not a readable MCP response.");
}

/** The text of the first text item of an MCP result; a tool error or a JSON-RPC error throws with its message. */
function resultText(body: string): string {
	const message = parseRpc(body);
	if (message.error !== undefined) {
		const detail = (message.error as { message?: unknown }).message;
		throw new SearchError(`Exa answered an error: ${typeof detail === "string" ? detail : "unknown error"}`);
	}
	const result = message.result as { isError?: unknown; content?: unknown } | null;
	const items = Array.isArray(result?.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>) : [];
	const text = items.find((item) => item?.type === "text" && typeof item.text === "string" && item.text.trim() !== "")
		?.text as string | undefined;
	if (result?.isError === true) throw new SearchError(`Exa answered an error: ${text?.trim() ?? "unknown error"}`);
	if (text === undefined) throw new SearchError("the answer had no text.");
	return text;
}

/** Exa's `web_search_exa` writes one `Title:` / `URL:` block per result, with `Text:` or `Highlights:` for the content. */
function parseResults(text: string): SearchResult[] {
	const results: SearchResult[] = [];
	for (const block of text.split(/(?=^Title: )/m)) {
		const title = /^Title: (.+)/m.exec(block)?.[1]?.trim() ?? "";
		const url = /^URL: (.+)/m.exec(block)?.[1]?.trim() ?? "";
		if (url === "") continue;
		let content = "";
		const textStart = block.indexOf("\nText: ");
		if (textStart >= 0) content = block.slice(textStart + 7);
		else {
			const highlights = /\nHighlights:\s*\n/.exec(block);
			if (highlights?.index !== undefined) content = block.slice(highlights.index + highlights[0].length);
		}
		const snippet = content
			.replace(/\n---\s*$/, "")
			.replace(/\s+/g, " ")
			.trim();
		results.push({
			title: clip(title || url, MAX_TITLE_CHARS),
			url: clip(url, MAX_URL_CHARS),
			snippet: clip(snippet, MAX_SNIPPET_CHARS),
		});
	}
	return results;
}

async function readBounded(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > MAX_ANSWER_BYTES) {
			await reader.cancel();
			throw new SearchError("the answer is over the 1 MiB limit.");
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

export function createWebSearchTool(options: WebSearchOptions = {}): ToolDefinition {
	const endpoint = options.endpoint ?? EXA_MCP_URL;
	const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;

	async function ask(query: string, numResults: number, signal: AbortSignal | undefined): Promise<string> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const response = await fetch(`${endpoint}?tools=${EXA_SEARCH_TOOL}`, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: EXA_SEARCH_TOOL, arguments: { query, numResults } },
				}),
				signal: controller.signal,
			});
			if (response.status === 429) {
				await response.body?.cancel();
				throw new SearchError(
					"Exa's anonymous rate limit was reached (429): the free search allows about 50 searches a day per IP address. API keys will be supported later.",
				);
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new SearchError(`Exa answered ${response.status}.`);
			}
			return await readBounded(response);
		} catch (error) {
			if (timedOut) throw new SearchError(`the request timed out after ${Math.round(timeoutMs / 1000)}s.`);
			if (signal?.aborted) throw new SearchError("the search was cancelled.");
			// fetch hides why a connection failed in `cause`.
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error) throw new SearchError(`${errorMessage(error)}: ${cause.message}`);
			throw error;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	return defineTool({
		name: "web_search",
		description: `Search the web with Exa's public MCP, without an API key, and return the title, URL and a snippet of each result. The query goes to Exa from the user's IP address, and the anonymous service allows about 50 searches a day, so search with a specific query instead of many small ones. Use web_fetch to read a result.`,
		inputShape: {
			query: z.string().min(1).describe("What to search for"),
			numResults: z
				.number()
				.int()
				.min(1)
				.max(MAX_RESULTS)
				.optional()
				.describe(`How many results to return, 1 to ${MAX_RESULTS} (default ${DEFAULT_RESULTS})`),
		},
		async execute({ query, numResults }, context) {
			const wanted = numResults ?? DEFAULT_RESULTS;
			try {
				const results = parseResults(resultText(await ask(query, wanted, context.signal))).slice(0, wanted);
				if (results.length === 0)
					return { ok: true, output: `No results for "${query}".`, summary: `${query} (no results)`, truncated: false };
				const output = results
					.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet === "" ? "" : `\n   ${r.snippet}`}`)
					.join("\n\n");
				return { ok: true, output, summary: `${query} (${results.length} results)`, truncated: false };
			} catch (error) {
				return failure(`Web search failed: ${errorMessage(error)}`, `${query} (failed)`);
			}
		},
	});
}

export const webSearchTool = createWebSearchTool();
