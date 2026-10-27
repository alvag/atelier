import { lookup } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { z } from "zod";
import { errorMessage, failure } from "./limits.ts";
import { defineTool, type ToolContext, type ToolDefinition } from "./types.ts";

/** Characters of a page one call returns; the rest is reached with `offset`. */
export const MAX_PAGE_CHARS = 30_000;
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const FETCH_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
/** Pages kept per session; the oldest goes first. */
const CACHE_ENTRIES = 20;

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
loopback.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

const internal = new BlockList();
internal.addSubnet("0.0.0.0", 8, "ipv4");
internal.addSubnet("10.0.0.0", 8, "ipv4");
internal.addSubnet("172.16.0.0", 12, "ipv4");
internal.addSubnet("192.168.0.0", 16, "ipv4");
internal.addSubnet("169.254.0.0", 16, "ipv4");
internal.addAddress("::", "ipv6");
internal.addSubnet("fc00::", 7, "ipv6");
internal.addSubnet("fe80::", 10, "ipv6");
for (const [network, bits] of [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["172.16.0.0", 12],
	["192.168.0.0", 16],
	["169.254.0.0", 16],
] as const)
	internal.addSubnet(`::ffff:${network}`, 96 + bits, "ipv6");

class RefusedError extends Error {
	override name = "RefusedError";
}

/** Throws for an address the tool never connects to: the machine itself and the networks behind it. */
function checkAddress(address: string, allowLoopback: boolean): void {
	const family = isIP(address) === 6 ? "ipv6" : "ipv4";
	if (!allowLoopback && loopback.check(address, family))
		throw new RefusedError(`Refused: ${address} is a loopback address.`);
	if (internal.check(address, family))
		throw new RefusedError(`Refused: ${address} is a private, link-local or otherwise internal address.`);
}

type Resolver = (hostname: string) => Promise<string[]>;

const resolveHost: Resolver = (hostname) =>
	new Promise((resolve, reject) =>
		lookup(hostname, { all: true }, (error, addresses) =>
			error ? reject(error) : resolve(addresses.map((a) => a.address)),
		),
	);

export interface WebFetchOptions {
	/** Name to addresses; tests pass their own. The default asks the system resolver. */
	resolve?: Resolver;
	/** Lets loopback through, for tests that serve pages from a local server; everything else stays refused. */
	allowLoopback?: boolean;
	timeoutMs?: number;
	/** The clock the page cache reads. */
	now?: () => number;
}

interface Page {
	text: string;
	at: number;
}

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const isTextType = (type: string) => type.startsWith("text/") || type === "application/json" || type.endsWith("+json");

function parseUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new RefusedError(`Not a valid URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new RefusedError(`Only http and https URLs can be fetched, not ${url.protocol}`);
	return url;
}

interface Response {
	status: number;
	type: string;
	location?: string;
	body: Buffer;
}

/** One request, no redirects. The connection goes to the address the guard checked, never to a second lookup. */
function requestOnce(
	url: URL,
	options: { resolve: Resolver; allowLoopback: boolean; signal: AbortSignal },
): Promise<Response> {
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (isIP(host) !== 0) checkAddress(host, options.allowLoopback);
	return new Promise((resolve, reject) => {
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const req = send(
			url,
			{
				agent: false,
				signal: options.signal,
				headers: { "user-agent": "Atelier web_fetch", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.1" },
				lookup: (hostname, _options, callback) => {
					options
						.resolve(hostname)
						.then((addresses) => {
							if (addresses.length === 0) throw new Error(`${hostname} did not resolve to any address`);
							for (const address of addresses) checkAddress(address, options.allowLoopback);
							const first = addresses[0] as string;
							// Node asks for every address when autoSelectFamily is on.
							if ((_options as { all?: boolean }).all)
								callback(
									null,
									addresses.map((address) => ({ address, family: isIP(address) })) as never,
									undefined as never,
								);
							else callback(null, first, isIP(first));
						})
						.catch((error) => callback(error, "", 0));
				},
			},
			(response: IncomingMessage) => {
				const status = response.statusCode ?? 0;
				const type = (response.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
				const location = response.headers.location;
				const finish = (body: Buffer) =>
					resolve({ status, type, ...(location === undefined ? {} : { location }), body });
				// A redirect or an error has no use for its body, but it is read under the same bound.
				const wanted = status >= 200 && status < 300;
				const declared = Number(response.headers["content-length"]);
				if (declared > MAX_BODY_BYTES) {
					response.destroy();
					reject(new RefusedError("The response is over the 5 MiB limit."));
					return;
				}
				const chunks: Buffer[] = [];
				let size = 0;
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_BODY_BYTES) {
						response.destroy();
						reject(new RefusedError("The response is over the 5 MiB limit."));
						return;
					}
					if (wanted) chunks.push(chunk);
				});
				response.on("end", () => finish(Buffer.concat(chunks)));
				response.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end();
	});
}

function htmlToMarkdown(html: string): string {
	const { document } = parseHTML(html);
	const article = new Readability(document as unknown as ConstructorParameters<typeof Readability>[0]).parse();
	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
	turndown.remove(["script", "style", "noscript"]);
	if (article?.content) {
		const markdown = turndown.turndown(article.content).trim();
		const title = article.title?.trim();
		return title && !markdown.startsWith("#") ? `# ${title}\n\n${markdown}` : markdown;
	}
	const body = document.body?.innerHTML ?? "";
	return turndown.turndown(body).trim();
}

function decode(body: Buffer): string {
	return new TextDecoder("utf-8").decode(body);
}

export function createWebFetchTool(options: WebFetchOptions = {}): ToolDefinition {
	const resolve = options.resolve ?? resolveHost;
	const allowLoopback = options.allowLoopback ?? false;
	const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
	const now = options.now ?? Date.now;
	// A session owns one `approvedPaths` set for its whole life, which makes it the key for that session's pages.
	const caches = new WeakMap<object, Map<string, Page>>();
	const shared = new Map<string, Page>();
	const cacheFor = (context: ToolContext) => {
		if (context.approvedPaths === undefined) return shared;
		const cache = caches.get(context.approvedPaths) ?? new Map<string, Page>();
		caches.set(context.approvedPaths, cache);
		return cache;
	};

	/** Downloads and converts one URL, following redirects through the same guard. */
	async function download(start: URL, signal: AbortSignal | undefined): Promise<string> {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			let url = start;
			for (let hops = 0; ; hops++) {
				const response = await requestOnce(url, { resolve, allowLoopback, signal: controller.signal });
				if (response.status >= 300 && response.status < 400 && response.location !== undefined) {
					if (hops >= MAX_REDIRECTS) throw new RefusedError(`Too many redirects (the limit is ${MAX_REDIRECTS}).`);
					url = parseUrl(new URL(response.location, url).href);
					continue;
				}
				if (response.status < 200 || response.status >= 300)
					throw new RefusedError(`The server answered ${response.status}.`);
				if (HTML_TYPES.has(response.type)) return htmlToMarkdown(decode(response.body));
				if (isTextType(response.type)) return decode(response.body);
				throw new RefusedError(
					`Cannot fetch ${response.type || "a response without a content type"}: only HTML, text and JSON.`,
				);
			}
		} catch (error) {
			if (timedOut) throw new RefusedError(`The request timed out after ${Math.round(timeoutMs / 1000)}s.`);
			throw error;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	return defineTool({
		name: "web_fetch",
		description: `Fetch a web page over http or https and return its text: HTML becomes Markdown, text and JSON are returned as they are, other types (PDF, images) are refused. Addresses on this machine or its private networks are refused. A response carries at most ${MAX_PAGE_CHARS} characters; when there is more, it says which offset to pass to read on. Needs the user's approval in normal mode.`,
		inputShape: {
			url: z.string().min(1).describe("The http or https URL to fetch"),
			offset: z.number().int().min(0).optional().describe("Character offset to continue a long page from"),
		},
		approvalCommand: ({ url }) => `web_fetch ${url}`,
		async gate({ url }) {
			try {
				parseUrl(url);
			} catch (error) {
				const message = errorMessage(error);
				return { refusal: { output: message, summary: message } };
			}
			// Going out to the network is not something the sandbox contains, like a bash command outside it.
			return {
				approval: { command: `web_fetch ${url}`, tool: "web_fetch", denial: `Not fetched: the user denied ${url}.` },
			};
		},
		async execute({ url, offset }, context) {
			const cache = cacheFor(context);
			try {
				const from = offset ?? 0;
				let page = from > 0 ? cache.get(url) : undefined;
				if (page && now() - page.at > CACHE_TTL_MS) {
					cache.delete(url);
					page = undefined;
				}
				if (!page) {
					page = { text: await download(parseUrl(url), context.signal), at: now() };
					cache.delete(url);
					cache.set(url, page);
					while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value as string);
				}
				const { text } = page;
				if (from > 0 && from >= text.length)
					return failure(
						`The page has ${text.length} characters; offset ${from} is past the end.`,
						`${url} (offset past the end)`,
					);
				const footer = (end: number) =>
					`\n\n[Showing characters ${from}-${end} of ${text.length}. Call web_fetch again with offset ${end} to continue.]`;
				let end = text.length;
				if (end - from > MAX_PAGE_CHARS) {
					// The footer counts toward the cap; it only gets shorter once its own offset is smaller.
					end = from + MAX_PAGE_CHARS - footer(from + MAX_PAGE_CHARS).length;
					end = from + MAX_PAGE_CHARS - footer(end).length;
				}
				const truncated = end < text.length;
				return {
					ok: true,
					output: `${text.slice(from, end)}${truncated ? footer(end) : ""}`,
					summary: `${url} (${text.length} characters)`,
					truncated,
				};
			} catch (error) {
				return failure(errorMessage(error), `${url} (${errorMessage(error)})`);
			}
		},
	});
}

export const webFetchTool = createWebFetchTool();
