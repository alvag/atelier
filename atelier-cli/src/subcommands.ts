import { type LoginTarget, parseLoginTarget } from "./login.ts";

/** A subcommand is chosen by the first positional word, exactly; anything else is a prompt. */
export interface Subcommand {
	name: "update" | "desktop" | "mcp" | "stats" | "login" | "logout" | "models";
	/** What `atelier login` and `atelier logout` were given. */
	target?: LoginTarget;
	/** What `atelier mcp` does, and to which server for `login` and `logout`. */
	action?: "list" | "login" | "logout";
	server?: string;
	/** The version `atelier update` was asked for. */
	version?: string;
	/** `atelier update --main`: the latest main instead of a release. */
	main?: true;
}

/** A stable release: strict semver, no prerelease, no leading zeros (install.sh applies the same rule). */
export const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

interface SubcommandSpec {
	usage: string;
	/** Reads the words after the name; throws the problem as a message. */
	parse(words: readonly string[], prompt: string, main: boolean): Subcommand;
}

const SPECS: Record<Subcommand["name"], SubcommandSpec> = {
	update: {
		usage: "atelier update [vX.Y.Z | --main]",
		parse(words, prompt, main) {
			const [version, ...extra] = words;
			if (extra.length > 0 || (version !== undefined && (main || !RELEASE_TAG.test(version))))
				throw new Error(
					`Usage: ${this.usage}. To give a prompt that starts with "update", quote it: atelier "${prompt}"`,
				);
			return {
				name: "update",
				...(version === undefined ? {} : { version }),
				...(main ? { main: true as const } : {}),
			};
		},
	},
	mcp: {
		usage: "atelier mcp list | atelier mcp login <server> | atelier mcp logout <server>",
		parse(words, prompt) {
			const [action, server, ...extra] = words;
			if (action === "list" && server === undefined) return { name: "mcp", action };
			if ((action === "login" || action === "logout") && server !== undefined && extra.length === 0)
				return { name: "mcp", action, server };
			throw new Error(`Usage: ${this.usage}. To give a prompt that starts with "mcp", quote it: atelier "${prompt}"`);
		},
	},
	login: {
		usage: "atelier login [account|api-key] [anthropic|opencode-go|openai-codex|openai-chatgpt]",
		parse(words, prompt) {
			const target = parseLoginTarget(words);
			if (target === undefined)
				throw new Error(
					`Usage: ${this.usage}. To give a prompt that starts with "login", quote it: atelier "${prompt}"`,
				);
			return { name: "login", target };
		},
	},
	logout: {
		usage: "atelier logout [account|api-key] [anthropic|opencode-go|openai-codex|openai-chatgpt]",
		parse(words, prompt) {
			const target = parseLoginTarget(words);
			if (target === undefined)
				throw new Error(
					`Usage: ${this.usage}. To give a prompt that starts with "logout", quote it: atelier "${prompt}"`,
				);
			return { name: "logout", target };
		},
	},
	stats: {
		usage:
			"atelier stats [--since 7d|30d|all|YYYY-MM-DD] [--project <dir>] [--by day|project|model|phase|role] [--json]",
		parse(words, prompt) {
			if (words.length > 0)
				throw new Error(
					`Usage: ${this.usage}. To give a prompt that starts with "stats", quote it: atelier "${prompt}"`,
				);
			return { name: "stats" };
		},
	},
	models: {
		usage: "atelier models [--refresh]",
		parse(words, prompt) {
			if (words.length > 0)
				throw new Error(
					`Usage: ${this.usage}. To give a prompt that starts with "models", quote it: atelier "${prompt}"`,
				);
			return { name: "models" };
		},
	},
	desktop: {
		usage: "atelier desktop",
		parse(words, prompt) {
			if (words.length > 0)
				throw new Error(
					`Usage: ${this.usage}. To give a prompt that starts with "desktop", quote it: atelier "${prompt}"`,
				);
			return { name: "desktop" };
		},
	},
};

/** The subcommand the positional words ask for, or undefined when they are a prompt. Throws a message on bad usage. */
export function parseSubcommand(positionals: readonly string[], main = false): Subcommand | undefined {
	const [first, ...words] = positionals;
	if (first === undefined || !Object.hasOwn(SPECS, first)) return undefined;
	return SPECS[first as Subcommand["name"]].parse(words, positionals.join(" "), main);
}
