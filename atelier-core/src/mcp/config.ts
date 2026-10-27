import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The user's MCP servers: `~/.atelier/mcp.json`, `{ "mcpServers": { <name>: <entry> } }`, the format of Pi and
 * Claude Code. A `command` makes a stdio server, a `url` a streamable HTTP one; SSE is refused. Values of `env` and
 * `headers` may name environment variables as `${NAME}`. An invalid entry is reported and skipped; the others load.
 */

/** What every server entry has, whatever its transport. */
interface ServerCommon {
	name: string;
	enabled: boolean;
	/** Per request, from the entry's `timeout` in seconds; 60 seconds by default. */
	timeoutMs: number;
	description?: string;
}

export interface StdioServerConfig extends ServerCommon {
	transport: "stdio";
	command: string;
	args: string[];
	env: Record<string, string>;
	/** Absolute; the session's directory when the entry has none. */
	cwd: string;
}

export interface HttpServerConfig extends ServerCommon {
	transport: "http";
	url: string;
	headers: Record<string, string>;
	/** A client registered with the server's authorization server, for servers without dynamic registration. */
	oauth?: OAuthSettings;
}

export interface OAuthSettings {
	clientId?: string;
	/** May name environment variables as `${NAME}`. */
	clientSecret?: string;
	/** The loopback port of the redirect URI, `http://127.0.0.1:<port>/callback`; a free one by default. */
	callbackPort?: number;
	/** Space-separated scopes, for servers that do not advertise them. */
	scope?: string;
	/** The name Atelier registers as; `Atelier` by default. */
	clientName?: string;
}

export type McpServerConfig = StdioServerConfig | HttpServerConfig;

/** An entry, or the whole file, that could not be taken; `name` is absent for the file. */
export interface McpConfigProblem {
	name?: string;
	message: string;
}

export interface McpConfig {
	file: string;
	servers: McpServerConfig[];
	problems: McpConfigProblem[];
	/** Every value that must never be shown: see `secretsOf`. */
	secrets: string[];
}

export const DEFAULT_TIMEOUT_SEC = 60;
const NAME = /^[A-Za-z0-9_-]+$/;
const TYPES = ["stdio", "http", "streamable-http"];

export function mcpConfigFile(home: string = homedir()): string {
	return join(home, ".atelier", "mcp.json");
}

export interface LoadMcpOptions {
	/** The session's directory: a relative `cwd` resolves against it. */
	cwd: string;
	home?: string;
	/** Where `${NAME}` is looked up; `process.env` by default. */
	env?: NodeJS.ProcessEnv;
	/** The configuration file; `~/.atelier/mcp.json` by default. */
	file?: string;
}

/** Reads the file; a missing one has no servers. Never throws: what cannot be taken is a problem. */
export function loadMcpConfig(options: LoadMcpOptions): McpConfig {
	const home = options.home ?? homedir();
	const file = options.file ?? mcpConfigFile(home);
	const config: McpConfig = { file, servers: [], problems: [], secrets: [] };
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			config.problems.push({ message: `${file} could not be read: ${(error as Error).message}` });
		return config;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		config.problems.push({ message: `${file} is not valid JSON: ${(error as Error).message}` });
		return config;
	}
	const servers = isRecord(parsed) ? parsed.mcpServers : undefined;
	if (servers === undefined && isRecord(parsed)) return config;
	if (!isRecord(servers)) {
		config.problems.push({ message: `${file} must be an object with an "mcpServers" object` });
		return config;
	}
	const secrets = new Set<string>();
	const seen = new Set<string>();
	for (const [name, entry] of Object.entries(servers)) {
		// Secrets are collected before validation, so an invalid entry's values are hidden as well.
		for (const secret of secretsOf(entry, options.env ?? process.env)) secrets.add(secret);
		const key = name.replaceAll("-", "_");
		if (seen.has(key)) {
			config.problems.push({ name, message: `the name is already used by another server (- and _ count the same)` });
			continue;
		}
		seen.add(key);
		const result = parseEntry(name, entry, { ...options, home });
		if (typeof result === "string") config.problems.push({ name, message: result });
		else config.servers.push(result);
	}
	config.secrets = [...secrets];
	return config;
}

/** The entry as a server, or what is wrong with it. */
function parseEntry(
	name: string,
	entry: unknown,
	options: LoadMcpOptions & { home: string },
): McpServerConfig | string {
	if (!NAME.test(name)) return "the name may contain only letters, digits, _ and -";
	if (!isRecord(entry)) return "the entry must be an object";
	const { type, command, url } = entry;
	if (type === "sse")
		return 'SSE is not supported; use the server\'s streamable HTTP endpoint (often "/mcp" instead of "/sse")';
	if (type !== undefined && (typeof type !== "string" || !TYPES.includes(type)))
		return `"type" must be "stdio", "http" or "streamable-http"`;
	if (command !== undefined && url !== undefined) return 'an entry has "command" or "url", not both';
	const enabled = entry.enabled ?? true;
	if (typeof enabled !== "boolean") return '"enabled" must be true or false';
	const timeout = entry.timeout ?? DEFAULT_TIMEOUT_SEC;
	if (typeof timeout !== "number" || !(timeout > 0)) return '"timeout" must be a positive number of seconds';
	const description = entry.description;
	if (description !== undefined && typeof description !== "string") return '"description" must be a string';
	const common = {
		name,
		enabled,
		timeoutMs: Math.round(timeout * 1000),
		...(description?.trim() ? { description: description.trim() } : {}),
	};
	const env = options.env ?? process.env;
	const wantsStdio = type === "stdio" || (type === undefined && command !== undefined);
	if (wantsStdio) {
		if (typeof command !== "string" || command === "") return 'a stdio server needs "command", one executable';
		const args = entry.args ?? [];
		if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string"))
			return '"args" must be a list of strings';
		const values = expandAll(entry.env, "env", env);
		if (typeof values === "string") return values;
		const cwd = entry.cwd;
		if (cwd !== undefined && typeof cwd !== "string") return '"cwd" must be a string';
		return {
			...common,
			transport: "stdio",
			command: tilde(command, options.home),
			args: args.map((arg) => tilde(arg, options.home)),
			env: values,
			cwd: cwd === undefined ? options.cwd : resolve(options.cwd, tilde(cwd, options.home)),
		};
	}
	if (type === undefined && url === undefined) return 'the entry needs "command" (stdio) or "url" (HTTP)';
	if (typeof url !== "string") return 'an HTTP server needs "url"';
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		return '"url" is not a valid URL';
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return '"url" must use http or https';
	const headers = expandAll(entry.headers, "headers", env);
	if (typeof headers === "string") return headers;
	const oauth = parseOAuth(entry.oauth, env);
	if (typeof oauth === "string") return oauth;
	return { ...common, transport: "http", url, headers, ...(oauth === undefined ? {} : { oauth }) };
}

/** The entry's `oauth` object, or what is wrong with it. */
function parseOAuth(value: unknown, env: NodeJS.ProcessEnv): OAuthSettings | string | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return '"oauth" must be an object';
	const settings: OAuthSettings = {};
	for (const key of ["clientId", "clientSecret", "scope", "clientName"] as const) {
		const field = value[key];
		if (field === undefined) continue;
		if (typeof field !== "string" || field === "") return `"oauth.${key}" must be a string`;
		if (key !== "clientSecret") settings[key] = field;
		else {
			const expanded = expand(field, env);
			if (expanded.missing !== undefined) return `"oauth.clientSecret" names \${${expanded.missing}}, which is not set`;
			settings.clientSecret = expanded.value;
		}
	}
	const port = value.callbackPort;
	if (port !== undefined) {
		if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)
			return '"oauth.callbackPort" must be a port number';
		settings.callbackPort = port;
	}
	return settings;
}

/** An `env` or `headers` object with every `${NAME}` replaced, or what is wrong with it. */
function expandAll(value: unknown, field: string, env: NodeJS.ProcessEnv): Record<string, string> | string {
	if (value === undefined) return {};
	if (!isRecord(value)) return `"${field}" must be an object of strings`;
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (typeof raw !== "string") return `"${field}.${key}" must be a string`;
		const expanded = expand(raw, env);
		if (expanded.missing !== undefined) return `"${field}.${key}" names \${${expanded.missing}}, which is not set`;
		out[key] = expanded.value;
	}
	return out;
}

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expand(raw: string, env: NodeJS.ProcessEnv): { value: string; missing?: string } {
	let missing: string | undefined;
	const value = raw.replace(VARIABLE, (_match, name: string) => {
		const found = env[name];
		if (found === undefined) missing ??= name;
		return found ?? "";
	});
	return missing === undefined ? { value } : { value, missing };
}

/**
 * Secrets at least this long are hidden wherever they appear; shorter ones only as a whole word, so a value such as
 * `a` or `1` does not blank those letters out of every text.
 */
const MIN_SECRET = 6;

/** A word of a value that looks like a token: long, with a digit or a symbol. Ordinary words stay visible. */
const tokenLike = (word: string) => word.length >= 8 && /[^A-Za-z]/.test(word);

/**
 * What an entry holds that must never be shown: every value of `env` and `headers` and `oauth.clientSecret`, as written and as expanded,
 * each word of it that looks like a token (the token of `Bearer <token>`), and the values of the URL's query (`?key=...`).
 */
export function secretsOf(entry: unknown, env: NodeJS.ProcessEnv): string[] {
	if (!isRecord(entry)) return [];
	const found: string[] = [];
	const add = (value: string) => {
		if (value !== "") found.push(value);
		for (const word of value.split(/\s+/)) if (word !== value && tokenLike(word)) found.push(word);
	};
	const oauth = isRecord(entry.oauth) ? { clientSecret: entry.oauth.clientSecret } : undefined;
	for (const field of [entry.env, entry.headers, oauth]) {
		if (!isRecord(field)) continue;
		for (const raw of Object.values(field)) {
			if (typeof raw !== "string") continue;
			add(raw);
			add(expand(raw, env).value);
			for (const [, name] of raw.matchAll(VARIABLE)) {
				const value = name === undefined ? undefined : env[name];
				if (value !== undefined) add(value);
			}
		}
	}
	if (typeof entry.url === "string") {
		try {
			for (const value of new URL(entry.url).searchParams.values()) add(value);
		} catch {}
	}
	return found;
}

/**
 * The text with every secret replaced by `***`, longest first so a secret inside another is hidden whole. A secret
 * shorter than `MIN_SECRET` is replaced only where it stands as a word of its own.
 */
export function redact(text: string, secrets: readonly string[]): string {
	let out = text;
	for (const secret of [...new Set(secrets)].sort((a, b) => b.length - a.length)) {
		if (secret === "") continue;
		if (secret.length >= MIN_SECRET) out = out.replaceAll(secret, "***");
		else out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(secret)}(?![\\p{L}\\p{N}_])`, "gu"), "***");
	}
	return out;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tilde(value: string, home: string): string {
	return value.startsWith("~/") ? join(home, value.slice(2)) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
