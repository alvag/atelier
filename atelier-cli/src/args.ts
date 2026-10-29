import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
	formatModel,
	PERMISSION_MODES,
	type PermissionMode,
	PROFILE_BACKENDS,
	parseModel,
	reviewEnabled,
	sandboxEnabled,
} from "@atelier/core";
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
	/** `explicitBackend` came from the prefix of --model, with no --backend. */
	backendFromModel?: true;
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
	/** The options of `atelier stats`, as given. */
	stats?: { since?: string; project?: string; by?: string; json?: true };
	/** `atelier models --refresh`: ask the sources before printing. */
	refreshModels?: true;
}

/** The options only `atelier stats` takes. */
const STATS_OPTIONS = ["since", "project", "by", "json"] as const;

export const USAGE = `Usage: atelier [options] [prompt]
       atelier update [vX.Y.Z | --main]
       atelier desktop
       atelier mcp list | login <server> | logout <server>
       atelier login [account|api-key] [anthropic|opencode-go|openai-codex|openai-chatgpt]
       atelier logout [account|api-key] [anthropic|opencode-go|openai-codex|openai-chatgpt]
       atelier stats [--since 7d|30d|all|YYYY-MM-DD] [--project <dir>]
                     [--by day|project|model|phase|role] [--json]
       atelier models [--refresh]

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
                         anthropic-api: Atelier's own loop, billed to an API key:
                         ANTHROPIC_API_KEY, else the one atelier login stored, else
                         the macOS Keychain (service atelier-anthropic)
                         opencode-go: the same loop on OpenCode Go's models:
                         OPENCODE_API_KEY, else the one atelier login stored
      --model <name>     Model to use (default: opus on claude-code,
                         claude-sonnet-5-5 on anthropic-api, minimax-m3 on opencode-go);
                         with a backend prefix, as in profiles (openai-codex/gpt-6-luna),
                         it also picks that backend, like --backend
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
are now; --model, --backend (it must be the one saved, as must a --model prefix), --mode
and --profile win over the saved ones. The files hold what the agent saw, tool output included.

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
server does not connect. atelier mcp login <server> signs a remote server in with OAuth
in the browser, and atelier mcp logout <server> deletes its sign-in. In a session, /mcp
prints the servers, and /mcp login <server> and /mcp logout <server> do the same.

atelier login signs in: with an account (Anthropic: Claude Code's own sign-in, in the
browser, for the claude-code backend) or with an API key (Anthropic, for anthropic-api),
asking what is not given and showing each provider's state. Keys go to
~/.atelier/auth.json (0600), which the agent cannot read. atelier logout lists what is
signed in and removes the one chosen; signing out of the Anthropic account signs Claude
Code out on this machine too, so it asks first. In a session, /login and /logout do the same.

atelier models prints the models /model offers for each backend: the code's list, then
the ones its provider listed (new), from ~/.atelier/models.json. --refresh asks models.dev
and the providers you are signed in to first.

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
  ATELIER_MEMORY_PROMPTS=off
                         Keep your prompts out of long-term memory
  ATELIER_REVIEW=off     Run without reviewing or verifying changes, like --no-review
  ATELIER_SANDBOX=off    Run bash without the sandbox, like --no-sandbox
  ATELIER_TUI=off        Run the interactive session line by line, without the
                         terminal interface
  ATELIER_MODEL_REFRESH=off
                         Do not ask models.dev or the providers for new models
  ATELIER_OFFLINE=1      The same (any value but empty or 0)
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
	if (values.backend !== undefined && !isBackendName(values.backend))
		throw new UsageError(`--backend must be ${BACKEND_NAMES.slice(0, -1).join(", ")} or ${BACKEND_NAMES.at(-1)}.`);
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
	if (values.refresh && subcommand?.name !== "models")
		throw new UsageError("--refresh is only valid with atelier models.");
	const statsOption = STATS_OPTIONS.find((name) => values[name] !== undefined);
	if (statsOption !== undefined && subcommand?.name !== "stats")
		throw new UsageError(`--${statsOption} is only valid with atelier stats.`);
	if (subcommand !== undefined) {
		const allowed =
			subcommand.name === "update"
				? ["help", "version", "main"]
				: subcommand.name === "stats"
					? ["help", "version", ...STATS_OPTIONS]
					: subcommand.name === "models"
						? ["help", "version", "refresh"]
						: ["help", "version"];
		const given = Object.keys(values).filter((name) => !allowed.includes(name));
		if (given.length > 0)
			throw new UsageError(
				`atelier ${subcommand.name} takes no session options (${given.map((name) => `--${name}`).join(", ")}).`,
			);
	}
	// Read only for a session: a subcommand has refused its session options above.
	const named = modelOption(values.model);
	if (named.backend !== undefined && values.backend !== undefined && named.backend !== values.backend)
		throw new UsageError(`--model names the ${named.backend} backend, but --backend is ${values.backend}.`);
	const chosenBackend = values.backend ?? named.backend;
	const backend = chosenBackend ?? DEFAULT_BACKEND;
	const prompt = subcommand === undefined && positionals.length > 0 ? positionals.join(" ") : undefined;
	if (prompt !== undefined && prompt.trim() === "") throw new UsageError("The prompt is empty.");
	return {
		...(prompt === undefined ? {} : { prompt }),
		yes: values.yes ?? false,
		...(mode === undefined ? {} : { mode }),
		...(named.model === undefined ? {} : { model: named.model }),
		backend,
		...(chosenBackend === undefined ? {} : { explicitBackend: chosenBackend }),
		...(values.backend === undefined && named.backend !== undefined ? { backendFromModel: true as const } : {}),
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
		...(values.refresh ? { refreshModels: true as const } : {}),
		...(subcommand?.name === "stats"
			? {
					stats: {
						...(values.since === undefined ? {} : { since: values.since }),
						...(values.project === undefined ? {} : { project: values.project }),
						...(values.by === undefined ? {} : { by: values.by }),
						...(values.json ? { json: true as const } : {}),
					},
				}
			: {}),
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
			since: { type: "string" },
			project: { type: "string" },
			by: { type: "string" },
			json: { type: "boolean" },
			refresh: { type: "boolean" },
		},
	});
}

/**
 * A model as `--model` and `/model` take it. A name with a backend prefix, `openai-codex/gpt-6-luna`, is read as
 * profiles read one and names its backend too; a name without one is taken as it is, unchecked.
 */
export function readModel(value: string): ReturnType<typeof parseModel> {
	const prefixed = PROFILE_BACKENDS.some((name) => value.startsWith(`${name}/`));
	return prefixed ? parseModel(value) : { ok: true, entry: { model: value } };
}

/**
 * Why the session `id`, saved on `saved`, cannot be resumed on the backend the arguments name, or undefined when it can.
 * A prefixed --model is told how to move the session there instead; `where` says where its /model is.
 */
export function resumeRefusal(args: CliArgs, id: string, saved: string, where = ""): string | undefined {
	const backend = args.explicitBackend;
	if (backend === undefined || backend === saved) return undefined;
	if (!args.backendFromModel) return `Session ${id} was saved on ${saved}; --backend ${backend} cannot resume it.`;
	const model = formatModel(backend, args.model ?? "");
	return `Session ${id} was saved on ${saved}, and --model ${model} names another backend: a resumed session keeps its backend. Resume it without that --model, then choose ${model} in /model${where} to move it there with a summary of the conversation.`;
}

function modelOption(value: string | undefined): { model?: string; backend?: BackendName } {
	if (value === undefined) return {};
	const read = readModel(value);
	if (!read.ok) throw new UsageError(`--model: ${read.why}.`);
	const { backend, model } = read.entry;
	return { ...(model === undefined ? {} : { model }), ...(backend === undefined ? {} : { backend }) };
}

function isPermissionMode(name: string): name is PermissionMode {
	return (PERMISSION_MODES as readonly string[]).includes(name);
}

function isBackendName(name: string): name is BackendName {
	return (BACKEND_NAMES as readonly string[]).includes(name);
}
