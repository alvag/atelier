import { resolve } from "node:path";
import { parseArgs } from "node:util";

export class UsageError extends Error {
	override name = "UsageError";
}

export interface CliArgs {
	/** Absent: interactive session. */
	prompt?: string;
	yes: boolean;
	model?: string;
	cwd: string;
	help: boolean;
	version: boolean;
}

export const USAGE = `Usage: atelier [options] [prompt]

Runs a coding agent in the working directory. With a prompt, runs one turn
and exits; without one, starts an interactive session (/exit or Ctrl+D to quit).

Options:
  -y, --yes            Run bash commands without asking
      --model <name>   Model to use (default: opus)
      --cwd <dir>      Working directory (default: current directory)
  -h, --help           Show this help
  -v, --version        Show the version
`;

export function parseCliArgs(argv: readonly string[], baseDir: string): CliArgs {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	const { values, positionals } = parsed;
	if (values.model !== undefined && values.model.trim() === "") throw new UsageError("--model needs a value.");
	const prompt = positionals.length > 0 ? positionals.join(" ") : undefined;
	if (prompt !== undefined && prompt.trim() === "") throw new UsageError("The prompt is empty.");
	return {
		...(prompt === undefined ? {} : { prompt }),
		yes: values.yes ?? false,
		...(values.model === undefined ? {} : { model: values.model }),
		cwd: resolve(baseDir, values.cwd ?? "."),
		help: values.help ?? false,
		version: values.version ?? false,
	};
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			yes: { type: "boolean", short: "y" },
			model: { type: "string" },
			cwd: { type: "string" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
}
