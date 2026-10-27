/** A subcommand is chosen by the first positional word, exactly; anything else is a prompt. */
export interface Subcommand {
	name: "update";
	/** The version `atelier update` was asked for. */
	version?: string;
}

export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

interface SubcommandSpec {
	usage: string;
	/** Reads the words after the name; throws the problem as a message. */
	parse(words: readonly string[], prompt: string): Subcommand;
}

const SPECS: Record<Subcommand["name"], SubcommandSpec> = {
	update: {
		usage: "atelier update [vX.Y.Z]",
		parse(words, prompt) {
			const [version, ...extra] = words;
			if (extra.length > 0 || (version !== undefined && !RELEASE_TAG.test(version)))
				throw new Error(
					`Usage: ${this.usage}. To give a prompt that starts with "update", quote it: atelier "${prompt}"`,
				);
			return { name: "update", ...(version === undefined ? {} : { version }) };
		},
	},
};

/** The subcommand the positional words ask for, or undefined when they are a prompt. Throws a message on bad usage. */
export function parseSubcommand(positionals: readonly string[]): Subcommand | undefined {
	const [first, ...words] = positionals;
	if (first === undefined || !Object.hasOwn(SPECS, first)) return undefined;
	return SPECS[first as Subcommand["name"]].parse(words, positionals.join(" "));
}
