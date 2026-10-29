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

type Subnet = readonly [network: string, bits: number];

function blockList(ipv4: Subnet[], ipv6: Subnet[]): BlockList {
	const list = new BlockList();
	for (const [network, bits] of ipv4) list.addSubnet(network, bits, "ipv4");
	for (const [network, bits] of ipv6) list.addSubnet(network, bits, "ipv6");
	return list;
}

const loopback = blockList([["127.0.0.0", 8]], [["::1", 128]]);

const internal = blockList(
	[
		["0.0.0.0", 8],
		["10.0.0.0", 8],
		["100.64.0.0", 10],
		["169.254.0.0", 16],
		["172.16.0.0", 12],
		["192.168.0.0", 16],
	],
	[
		["::", 128],
		["64:ff9b:1::", 48],
		["fc00::", 7],
		["fe80::", 10],
		["fec0::", 10],
	],
);

const special = blockList(
	[
		["192.0.0.0", 24],
		["192.0.2.0", 24],
		["198.18.0.0", 15],
		["198.51.100.0", 24],
		["203.0.113.0", 24],
		["224.0.0.0", 4],
		["240.0.0.0", 4],
	],
	[
		["100::", 64],
		["2001:db8::", 32],
		["ff00::", 8],
	],
);

/** IPv4-mapped, IPv4-compatible, SIIT and NAT64 addresses reach the IPv4 in their last 32 bits. */
const carriesIpv4 = blockList(
	[],
	[
		["::ffff:0:0", 96],
		["::", 96],
		["::ffff:0:0:0", 96],
		["64:ff9b::", 96],
	],
);

class RefusedError extends Error {
	override name = "RefusedError";
}

/** The eight 16-bit groups of an IPv6 address, with a dotted IPv4 tail as the last two; null when it cannot be read. */
function ipv6Groups(address: string): number[] | null {
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
	let hex = address;
	if (dotted) {
		const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
		hex = `${address.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = hex.split("::");
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves[1] ? halves[1].split(":") : [];
	const gap = halves.length === 2 ? 8 - head.length - tail.length : 0;
	if (halves.length > 2 || gap < 0) return null;
	const groups = [...head, ...Array<string>(gap).fill("0"), ...tail].map((group) => Number.parseInt(group, 16));
	return groups.length === 8 && groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

/** The IPv4 in the last 32 bits of an IPv6 address. */
function embeddedIpv4(address: string): string {
	const groups = ipv6Groups(address);
	if (!groups) throw new RefusedError(`Refused: ${address} is not an IP address.`);
	const [high, low] = groups.slice(6) as [number, number];
	return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** Why the tool never connects to an address, or null when it may: the machine itself, the networks behind it and the special-use ranges. */
function refusal(address: string, allowLoopback: boolean): string | null {
	const family = isIP(address);
	if (family === 0) return "not an IP address";
	const type = family === 6 ? "ipv6" : "ipv4";
	if (loopback.check(address, type)) return allowLoopback ? null : "a loopback address";
	if (internal.check(address, type)) return "a private, link-local or otherwise internal address";
	if (special.check(address, type)) return "a reserved, multicast or documentation address";
	return null;
}

/** Throws for an address the tool never connects to, including an IPv6 address that carries such an IPv4. */
function checkAddress(raw: string, allowLoopback: boolean): void {
	const address = raw.split("%")[0] as string;
	const reason = refusal(address, allowLoopback);
	if (reason) throw new RefusedError(`Refused: ${address} is ${reason}.`);
	// `::1` lies inside `::/96`; when loopback is allowed it must not be read as 0.0.0.1.
	if (isIP(address) !== 6 || loopback.check(address, "ipv6") || !carriesIpv4.check(address, "ipv6")) return;
	const ipv4 = embeddedIpv4(address);
	const carried = refusal(ipv4, allowLoopback);
	if (carried) throw new RefusedError(`Refused: ${address} carries ${ipv4}, ${carried}.`);
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
		description: `Fetch a web page over http or https and return its text: HTML becomes Markdown, text and JSON are returned as they are, other types (PDF, images) are refused. Addresses on this machine or its private networks are refused. A response carries at most ${MAX_PAGE_CHARS} characters; when there is more, it says which offset to pass to read on.`,
		inputShape: {
			url: z.string().min(1).describe("The http or https URL to fetch"),
			offset: z.number().int().min(0).optional().describe("Character offset to continue a long page from"),
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
