import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { PERMISSION_MODES, type PermissionMode, reviewEnabled, sandboxEnabled } from "@atelier/core";
import { BACKEND_NAMES, type BackendName, DEFAULT_BACKEND } from "@atelier/core/protocol";
import { parseSubcommand, type Subcommand } from "./subcommands.ts";

export class UsageError extends Error {
	override name = "UsageError";
}

export interface CliArgs {
	/** Absent: interactive session. */
	prompt?: string;
	/** Deprecated: --yes, an alias of `--mode normal`. */
	yes: boolean;
	/** Present only when --mode was given: it wins over --yes and over the default saved in the home. */
	mode?: PermissionMode;
	model?: string;
	backend: BackendName;
	/** Present only when --backend was given: it wins over the backend the orchestrator's profile entry names. */
	explicitBackend?: BackendName;
	/** The profile chosen with --profile: the first layer of the resolution. */
	profile?: string;
	cwd: string;
	help: boolean;
	version: boolean;
	/** Changes are reviewed (RDD): on unless --no-review or ATELIER_REVIEW=off. */
	review: boolean;
	/** Present when `bash` runs without the sandbox: --no-sandbox or ATELIER_SANDBOX=off. */
	noSandbox?: true;
	/** --continue: resume the newest saved session of `cwd`. */
	continueSession?: true;
	/** --resume <id>: resume that saved session of `cwd`. */
	resume?: string;
	/** --no-session: the session is not saved. */
	noSession?: true;
	/** --no-fullscreen: the TUI runs in the terminal's main screen, over `tui.fullscreen` in the settings. */
	noFullscreen?: true;
	/** The first positional word names a subcommand (`atelier update`): no session starts. */
	subcommand?: Subcommand;
}

export const USAGE = `Usage: atelier [options] [prompt]
       atelier update [vX.Y.Z | --main]
       atelier desktop
       atelier mcp list

Runs a coding agent in the working directory. With a prompt, runs one turn
and exits; without one, starts an interactive session (/exit or Ctrl+D to quit),
in a terminal interface when stdin and stdout are terminals.

Options:
      --mode <mode>      Permission mode of the session: normal (default; commands that
                         run in the sandbox never ask, except the ones the guard
                         confirms in every mode: recursive removal, git push, ...),
                         auto (what normal would ask goes to a classifier model, the
                         session's unless the profile's permission-classifier role sets
                         one, which allows or denies it; you are asked when it cannot
                         decide; the guard's confirmations always ask you) or yolo
                         (nothing outside the sandbox or --cwd asks, and of the guard's
                         confirmations only a plain git push or rebase is waived);
                         without it, the default saved with /mode default, else normal
  -y, --yes              Deprecated alias of --mode normal; prints a warning
      --backend <name>   claude-code (default): Claude Code on your Claude subscription
                         anthropic-api: Atelier's own loop, billed to an API key read
                         from the macOS Keychain (service atelier-anthropic) or from
                         ANTHROPIC_API_KEY
      --model <name>     Model to use (default: opus on claude-code,
                         claude-sonnet-5-5 on anthropic-api)
      --profile <name>   Agent profile from ~/.atelier/profiles.json for this session,
                         over the local pin, the repository's and the active one;
                         --model and --backend still replace the main agent's
      --cwd <dir>        Working directory (default: current directory)
      --continue         Resume the newest saved session of the working directory
      --resume <id>      Resume that saved session of the working directory
      --no-session       Do not save this session (it cannot be resumed)
      --no-fullscreen    Run the interactive session in the terminal's main screen,
                         under what was there, instead of the full screen
      --no-review        Do not review or verify changes (see below)
      --no-sandbox       Run bash without the macOS sandbox: every command asks in
                         normal mode and goes to the classifier in auto mode, and
                         each turn warns about it
  -h, --help             Show this help
  -v, --version          Show the version

Sessions are saved under ~/.atelier/sessions/, one folder per working directory: the
configuration, the prompts, the events and what the backend needs to resume. --continue
and --resume print what was said (each prompt and the answer's final text), then go on as
usual, interactive or with a prompt. The profile is frozen again from the files as they
are now; --model, --backend (it must be the one saved), --mode and --profile win over
the saved ones. The files hold what the agent saw, tool output included.

atelier update [vX.Y.Z | --main] moves a copy installed with install.sh to the newest
release, or to the one named (to go back), or with --main to the latest main of GitHub
(atelier --version then shows it as 0.2.0 (main 20c5424)), and reinstalls its dependencies.
A plain atelier update goes back to the newest release. It takes no other options; to give
a prompt that starts with "update", quote it: atelier "update the readme".

atelier desktop opens the desktop app, in the same version as the CLI. The first time in a
copy installed with install.sh it installs Electron (about 200 MB) and builds the app; install.sh
--desktop does that up front, and atelier update rebuilds it. It takes no options.

atelier mcp list connects to every MCP server of ~/.atelier/mcp.json and prints its
state, its tools and its errors; it exits with 1 when an entry is invalid or an enabled
server does not connect. In a session, /mcp prints the same for the session's servers.

Long-term memory is used when its memory service is installed; the session says
which project it uses, or why it has none.

After a turn that leaves risky uncommitted changes in a git repository, Atelier asks
whether to review them (the question needs a terminal; no mode answers it).
In an interactive session, /compact [instructions] summarizes the older history now,
keeping the latest messages and what the instructions ask for.

In an interactive session, /mode [normal|auto|yolo] prints the session's permission
mode, or changes it for this session; /mode default <normal|auto|yolo> saves the
default for new sessions without changing the running one.

In an interactive session, /review reviews the current changes at any risk, against
HEAD; /review <ref> reviews them against that git ref instead. A review never commits
anything. /undo-correction puts back the files the repository's latest escalated review's
correction changed, even from an earlier session, unless they changed since or the
correction was committed.

Environment:
  ATELIER_MEMORY=off     Run without long-term memory
  ATELIER_REVIEW=off     Run without reviewing or verifying changes, like --no-review
  ATELIER_SANDBOX=off    Run bash without the sandbox, like --no-sandbox
  ATELIER_TUI=off        Run the interactive session line by line, without the
                         terminal interface
  ATELIER_ALLOW_ROOT     As root (uid 0) Atelier refuses to start unless this is exactly
                         "I accept the risk"; it then warns on every start
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
	if (values.profile !== undefined && values.profile.trim() === "") throw new UsageError("--profile needs a value.");
	const mode = values.mode;
	if (mode !== undefined && !isPermissionMode(mode)) throw new UsageError("--mode must be normal, auto or yolo.");
	const backend = values.backend ?? DEFAULT_BACKEND;
	if (!isBackendName(backend)) throw new UsageError(`--backend must be ${BACKEND_NAMES.join(" or ")}.`);
	if (values.resume !== undefined && values.resume.trim() === "") throw new UsageError("--resume needs a value.");
	if (values.continue && values.resume !== undefined)
		throw new UsageError("--continue and --resume cannot be used together.");
	if (values["no-session"] && (values.continue || values.resume !== undefined))
		throw new UsageError(
			"--no-session cannot be used with --continue or --resume: a session that is not saved cannot be resumed.",
		);
	let subcommand: Subcommand | undefined;
	try {
		subcommand = parseSubcommand(positionals, values.main ?? false);
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	if (values.main && subcommand === undefined) throw new UsageError("--main is only valid with atelier update.");
	if (subcommand !== undefined) {
		const allowed = subcommand.name === "update" ? ["help", "version", "main"] : ["help", "version"];
		const given = Object.keys(values).filter((name) => !allowed.includes(name));
		if (given.length > 0)
			throw new UsageError(
				`atelier ${subcommand.name} takes no session options (${given.map((name) => `--${name}`).join(", ")}).`,
			);
	}
	const prompt = subcommand === undefined && positionals.length > 0 ? positionals.join(" ") : undefined;
	if (prompt !== undefined && prompt.trim() === "") throw new UsageError("The prompt is empty.");
	return {
		...(prompt === undefined ? {} : { prompt }),
		yes: values.yes ?? false,
		...(mode === undefined ? {} : { mode }),
		...(values.model === undefined ? {} : { model: values.model }),
		backend,
		...(values.backend === undefined ? {} : { explicitBackend: backend }),
		...(values.profile === undefined ? {} : { profile: values.profile }),
		cwd: resolve(baseDir, values.cwd ?? "."),
		help: values.help ?? false,
		version: values.version ?? false,
		review: !(values["no-review"] ?? false) && reviewEnabled(env),
		...((values["no-sandbox"] ?? false) || !sandboxEnabled(env) ? { noSandbox: true as const } : {}),
		...(values.continue ? { continueSession: true as const } : {}),
		...(values.resume === undefined ? {} : { resume: values.resume }),
		...(values["no-session"] ? { noSession: true as const } : {}),
		...(values["no-fullscreen"] ? { noFullscreen: true as const } : {}),
		...(subcommand === undefined ? {} : { subcommand }),
	};
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			yes: { type: "boolean", short: "y" },
			mode: { type: "string" },
			model: { type: "string" },
			backend: { type: "string" },
			profile: { type: "string" },
			cwd: { type: "string" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
			"no-review": { type: "boolean" },
			"no-sandbox": { type: "boolean" },
			continue: { type: "boolean" },
			resume: { type: "string" },
			"no-session": { type: "boolean" },
			"no-fullscreen": { type: "boolean" },
			main: { type: "boolean" },
		},
	});
}

function isPermissionMode(name: string): name is PermissionMode {
	return (PERMISSION_MODES as readonly string[]).includes(name);
}

function isBackendName(name: string): name is BackendName {
	return (BACKEND_NAMES as readonly string[]).includes(name);
}
