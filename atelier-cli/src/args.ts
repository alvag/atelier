import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { reviewEnabled } from "@atelier/core";
import { BACKEND_NAMES, type BackendName, DEFAULT_BACKEND } from "@atelier/core/protocol";

export class UsageError extends Error {
	override name = "UsageError";
}

export interface CliArgs {
	/** Absent: interactive session. */
	prompt?: string;
	yes: boolean;
	model?: string;
	backend: BackendName;
	cwd: string;
	help: boolean;
	version: boolean;
	/** Changes are reviewed (RDD): on unless --no-review or ATELIER_REVIEW=off. */
	review: boolean;
}

export const USAGE = `Usage: atelier [options] [prompt]

Runs a coding agent in the working directory. With a prompt, runs one turn
and exits; without one, starts an interactive session (/exit or Ctrl+D to quit).

Options:
  -y, --yes              Run bash commands without asking
      --backend <name>   claude-code (default): Claude Code on your Claude subscription
                         anthropic-api: Atelier's own loop, billed to an API key read
                         from the macOS Keychain (service atelier-anthropic) or from
                         ANTHROPIC_API_KEY
      --model <name>     Model to use (default: opus on claude-code,
                         claude-sonnet-5-5 on anthropic-api)
      --cwd <dir>        Working directory (default: current directory)
      --no-review        Do not review uncommitted changes (see below)
  -h, --help             Show this help
  -v, --version          Show the version

Long-term memory is used when its memory service is installed; the session says
which project it uses, or why it has none.

After a turn that leaves risky uncommitted changes in a git repository, Atelier asks
whether to review them (the question needs a terminal; --yes does not answer it).
In an interactive session, /compact [instructions] summarizes the older history now,
keeping the latest messages and what the instructions ask for.

In an interactive session, /review reviews the current changes at any risk. A review
never commits anything.

Environment:
  ATELIER_MEMORY=off     Run without long-term memory
  ATELIER_REVIEW=off     Run without reviewing changes, like --no-review
  ATELIER_COMPACT_AT=<n> Context tokens at which anthropic-api sessions summarize their
                         older history (default: the model's window minus a reserve,
                         at most 200000; never more than the window minus the reserve)
`;

export function parseCliArgs(
	argv: readonly string[],
	baseDir: string,
	env: Record<string, string | undefined> = {},
): CliArgs {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	const { values, positionals } = parsed;
	if (values.model !== undefined && values.model.trim() === "") throw new UsageError("--model needs a value.");
	const backend = values.backend ?? DEFAULT_BACKEND;
	if (!isBackendName(backend)) throw new UsageError(`--backend must be ${BACKEND_NAMES.join(" or ")}.`);
	const prompt = positionals.length > 0 ? positionals.join(" ") : undefined;
	if (prompt !== undefined && prompt.trim() === "") throw new UsageError("The prompt is empty.");
	return {
		...(prompt === undefined ? {} : { prompt }),
		yes: values.yes ?? false,
		...(values.model === undefined ? {} : { model: values.model }),
		backend,
		cwd: resolve(baseDir, values.cwd ?? "."),
		help: values.help ?? false,
		version: values.version ?? false,
		review: !(values["no-review"] ?? false) && reviewEnabled(env),
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
			backend: { type: "string" },
			cwd: { type: "string" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
			"no-review": { type: "boolean" },
		},
	});
}

function isBackendName(name: string): name is BackendName {
	return (BACKEND_NAMES as readonly string[]).includes(name);
}
