import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
	type AtelierEvent,
	type AtelierEventBody,
	type ClientCommand,
	describeError,
	type JsonValue,
	type McpServerStatus,
	normalizeImage,
	type PermissionMode,
	type PreparedImage,
	type QueuedMessage,
	type QueueKind,
	type SavedEntry,
	type SavedSessionInfo,
	type SecurityRunner,
	type SessionConfiguration,
	visibleText,
	writeDefaultPermissionMode,
} from "@atelier/core";
import { type CoreExit, RpcError } from "@atelier/core/client";
import type { BackendName, UserAnswer } from "@atelier/core/protocol";
import {
	type AutocompleteItem,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	getTerminalColorMode,
	Loader,
	matchesKey,
	type Terminal,
	type TerminalColors,
	Text,
} from "@earendil-works/pi-tui";
import { type CliArgs, readModel, resumeRefusal } from "../args.ts";
import {
	LOGIN_USAGE,
	LOGOUT_USAGE,
	type LoginPorts,
	login,
	logout,
	type OpenAiLoginHooks,
	parseLoginTarget,
} from "../login.ts";
import { mcpReport } from "../mcp-report.ts";
import {
	PERMISSIONS_USAGE,
	parsePermissions,
	removedText,
	rulesListing,
	ruleText,
	type ShownRule,
} from "../permission-text.ts";
import { savedParts } from "../transcript.ts";
import { type AskAnswer, AskDialog } from "./ask-dialog.ts";
import { Attention } from "./attention.ts";
import { readClipboardImage } from "./clipboard-image.ts";
import { Conversation } from "./conversation.ts";
import {
	type Choice,
	ChoiceDialog,
	type Folded,
	PasteDialog,
	PasteFilter,
	SearchDialog,
	SecretDialog,
} from "./dialog.ts";
import { FeaturePanel } from "./feature-panel.ts";
import {
	type FooterState,
	FULLSCREEN_FOOTER_ITEMS,
	footerAfter,
	footerLine,
	footerWithConfiguration,
	footerWithMode,
	type StatusItem,
} from "./footer.ts";
import { type GitChanges, readGitBranch, readGitChanges } from "./git-branch.ts";
import { Header, type HeaderState, StatusBar } from "./header.ts";
import { HerdrStatusReporter, PANE_MARKER } from "./herdr-status.ts";
import { createScreen, keepDocument, mount } from "./layout.ts";
import { preparePastedImages } from "./pasted-images.ts";
import { ProgramStatusReporter } from "./program-status.ts";
import { PromptEditor, parseShell } from "./prompt.ts";
import { type ImageDraft, PromptImages } from "./prompt-images.ts";
import { QueuePanel } from "./queue-panel.ts";
import {
	choicesOf,
	LIST_ROWS,
	modeChoices,
	modelChoices,
	nextMode,
	type Options,
	profileChoices,
	sessionChoices,
} from "./selectors.ts";
import { readTuiSettings } from "./settings.ts";
import { isStatsCommand, parseStatsCommand, STATS_USAGE, statsNote } from "./stats-command.ts";
import { StatusLine, terminalTitle } from "./status-line.ts";
import { editorTheme, type Paint, painter, Shade, Tones } from "./style.ts";
import { activeTheme, ink } from "./theme.ts";
import { runUserShell, type UserShellOptions, type UserShellResult } from "./user-shell.ts";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
/** A paste longer than this is text, not the path of a file. */
const PATH_PASTE_CHARS = 4096;
const IMAGES_BUSY = "Images cannot be queued. Wait for the current turn to finish.";
const COMMAND_WAITS = "commands run when the turn ends; it stays in the editor";
// biome-ignore lint/suspicious/noControlCharactersInRegex: an escape sequence is one key
const KEYS = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[\s\S]|[\s\S]/gu;
const NO_CLIPBOARD_IMAGE = "No image on the clipboard. To paste text, use your terminal's text paste.";
const CLIPBOARD_UNSUPPORTED =
	"Ctrl+V attaches clipboard images on macOS only. To paste text, use your terminal's text paste.";
const ANIMATED = "Animated image: only the first frame was attached.";
const SHELL_BUSY = "A shell command is already running. Press Esc to cancel it first.";
const SHELL_IMAGES = "Images cannot be sent with a shell command. Remove the shell marker or the images.";

/** The core as the TUI talks to it: `RpcClient`, or an in-process server in tests. */
export interface CoreLink {
	request(command: ClientCommand): Promise<unknown>;
	onEvent(listener: (sessionId: string, event: AtelierEvent) => void): () => void;
	/** Events outside any turn: a background job that ended while no turn ran and none will start for it. */
	onSessionEvent?(listener: (sessionId: string, event: AtelierEventBody) => void): () => void;
	onExit(listener: (exit: CoreExit) => void): () => void;
	close(): Promise<void>;
}

export interface TuiOptions {
	terminal: Terminal;
	/** Starts the core with these variables added to the environment (the switches --no-sandbox and --no-review set). */
	connect: (env: Record<string, string>) => Promise<CoreLink>;
	stderr: (text: string) => void;
	home?: string;
	color: boolean;
	/** Atelier's version, for the header. */
	version?: string;
	/** The CLI's environment, where Herdr says which pane the TUI runs in. */
	env?: Record<string, string | undefined>;
	/** Registers a handler for SIGTERM and SIGHUP, given the signal's number; returns a function that removes it. */
	onTerminate?: (handler: (signal: number) => void) => () => void;
	/** Registers a Ctrl+C (SIGINT) handler; returns a function that removes it. Used while Claude Code has the terminal. */
	onInterrupt?: (handler: () => void) => () => void;
	/** The Claude Code binary `/login` runs; the one Atelier installs when absent. Tests pass a fake. */
	claudeCode?: string;
	/** What asks the macOS Keychain whether it has a key, for `/login`; tests pass a fake. */
	runSecurity?: SecurityRunner;
	/** The browser and the auth server of the OpenAI sign-ins; tests pass fakes. */
	openaiLogin?: OpenAiLoginHooks;
	/** What the session's backend lacks (a login, a key), said at start; nothing is checked when absent. */
	checkLogin?: (backend: string) => Promise<string | undefined>;
	/** How long closing the session may take before the core is closed anyway (default 3000 ms). */
	closeTimeoutMs?: number;
	/** How long an approval ignores keys after it appears, so one typed before it does not answer it (default 400 ms). */
	answerGuardMs?: number;
	/** How often the terminal is told a running turn's new line at most (default 500 ms). */
	statusIntervalMs?: number;
	/** The system the clipboard images and notices are for (default: this process's). */
	platform?: NodeJS.Platform;
	/** The clipboard's image as PNG or TIFF bytes for Ctrl+V; undefined when it holds none (default: macOS's pasteboard). */
	readClipboardImage?: (signal: AbortSignal) => Promise<Uint8Array | undefined>;
	/** Runs the commands typed after `!` and `!!` (default: `runUserShell`); tests pass a fake. */
	runShell?: (command: string, options: UserShellOptions) => Promise<UserShellResult>;
	/** Starts a notice's command (default: detached). */
	spawn?: (command: string, args: string[]) => void;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_INTERRUPTED = 130;
const SIGNAL_EXIT = 128;
const CLOSE_TIMEOUT_MS = 3000;
const ANSWER_GUARD_MS = 400;
/** How long the terminal has to say its colors; the shade starts as the palette's until then, and stays so after. */
const COLOR_QUERY_MS = 500;

const RENAME_USAGE = "/rename <name>";

const COMMANDS = [
	{ name: "model", description: "Change the model, of any provider you are signed in to [provider/model]" },
	{ name: "effort", description: "Change the thinking level from the next turn [level]" },
	{ name: "profile", description: "Freeze another profile for this session [name]" },
	{ name: "mode", description: "Change the permission mode: [normal|auto|yolo] | default <mode>" },
	{ name: "feature", description: "Open or fold the ODD feature's tasks (Ctrl+T)" },
	{ name: "mcp", description: "Show the MCP servers; login|logout <server> signs one in or out" },
	{ name: "permissions", description: "List the permission rules you allowed; remove <number> removes one" },
	{ name: "login", description: "Sign in with an account or an API key [account|api-key] [provider]" },
	{ name: "logout", description: "Sign out of a stored API key or an account [account|api-key] [provider]" },
	{ name: "new", description: "Start a new session" },
	{ name: "resume", description: "Resume a saved session of this folder [id]" },
	{ name: "rename", description: "Name this session <name>" },
	{ name: "review", description: "Review the current changes, against HEAD or a git ref" },
	{ name: "undo-correction", description: "Undo the latest escalated review's correction" },
	{ name: "compact", description: "Summarize the older history now [instructions]" },
	{ name: "status", description: "Show what the session runs with, what it loaded and its cost" },
	{ name: "stats", description: "Show what this session spent; project: this folder's sessions [--since 7d]" },
	{ name: "exit", description: "Close the session" },
];

/** What a typed `/backend` says, instead of reaching the model as a prompt. */
const BACKEND_GONE = "/backend no longer exists: pick a model of another provider in /model";

/** Under `/model`'s list: why a provider may be missing from it. */
const MODEL_NOTE = "Only showing models from configured providers. Use /login to add providers.";

/** The answer a list gives when Esc closes it. */
const CANCELLED = "\0";

const shown = (text: string) => visibleText(text);
const isMode = (word: string | undefined): word is PermissionMode =>
	word === "normal" || word === "auto" || word === "yolo";

/** ` (asked by worker)` for a subagent's question; the main agent's says nothing. */
const asker = (event: AtelierEvent) =>
	event.parentCallId === undefined
		? ""
		: ` (asked by ${event.agent === undefined ? "a subagent" : shown(event.agent).text})`;

/** What a question of the core says to the terminal while it waits. */
type Blocked = { kind: "permission" | "question" | "user_question"; message: string };

/** The question an approval asks, worded as the CLI's yes/no question. */
function approvalQuestion(event: Extract<AtelierEvent, { type: "approval_requested" }>): {
	title: string;
	lines: string[];
	folded?: Folded;
} {
	const command = shown(event.command);
	if (event.tool === "edit" || event.tool === "write") {
		const path = shown(event.command.slice(`${event.tool} `.length));
		const warning = path.hadHidden
			? ["warning: the path contains invisible or control characters, shown as markers."]
			: [];
		return {
			title: `${event.tool === "edit" ? "Edit" : "Write"} a file outside the working directory?${asker(event)}`,
			lines: [path.text, ...warning],
		};
	}
	if (event.tool === "mcp_call") {
		const warning = command.hadHidden
			? ["warning: the call contains invisible or control characters, shown as markers."]
			: [];
		return { title: `Call this MCP tool?${asker(event)}`, lines: [command.text, ...warning] };
	}
	const reason = event.reason === undefined ? undefined : shown(event.reason);
	const guard = event.confirm === undefined ? "" : ` (guard: ${shown(event.confirm).text})`;
	const warning =
		command.hadHidden || reason?.hadHidden
			? ["warning: the command contains invisible or control characters, shown as markers."]
			: [];
	const lines = [command.text, ...(reason ? [`reason: ${reason.text}`] : []), ...warning];
	// Folded, the command's first line with text; the rest, the reason included, opens with Ctrl+O. A warning always shows.
	const commandLines = command.text.split("\n");
	const first = commandLines.find((line) => line.trim() !== "") ?? "";
	const reasonLines = reason ? reason.text.split("\n").length : 0;
	return {
		title: `${reason ? "Run this command OUTSIDE the sandbox?" : "Run this command?"}${guard}${asker(event)}`,
		lines,
		folded: { lines: [first, ...warning], hidden: commandLines.length - 1 + reasonLines },
	};
}

/** Allow and Deny, and between them the answers that remember the question's rules when it offers them. */
function approvalChoices(event: Extract<AtelierEvent, { type: "approval_requested" }>) {
	const remember = event.remember;
	const what = remember === undefined ? "" : ruleText(event.tool, remember.rules);
	return [
		{ value: "allow", label: "Allow" },
		...(remember === undefined ? [] : [{ value: "session", label: `Allow ${what} in this session` }]),
		...(remember?.always ? [{ value: "always", label: `Allow ${what} always` }] : []),
		...(remember?.project === undefined ? [] : [{ value: "project", label: `Allow ${what} always in this project` }]),
		{ value: "deny", label: "Deny" },
	];
}

/** The review question: why it is asked is in the review block just above it. */
const CONSENT_TITLE = "Review this high-risk change?";

/** The fixed status line under the editor, with the items chosen in the settings. */
class Footer implements Component {
	/** What the session says. */
	state: FooterState = {};
	/** Where the TUI works and which Atelier runs, which a new or resumed session keeps. */
	place: Pick<FooterState, "cwd" | "branch" | "version"> = {};
	readonly #paint: Paint;
	readonly #items: readonly StatusItem[];
	constructor(paint: Paint, items: readonly StatusItem[]) {
		this.#paint = paint;
		this.#items = items;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.#items.length === 0
			? []
			: [footerLine({ ...this.state, ...this.place }, width, this.#paint, this.#items)];
	}
}

/**
 * A session the TUI runs: its id in the core, its file's id when it is saved, what its next turn runs with, and what
 * the terminal's title names it by: its name, or its first prompt.
 */
interface Opened {
	sessionId: string;
	savedId?: string;
	configuration?: SessionConfiguration;
	name?: string;
}

/** The mode requests of one session: how many were sent, the newest the core accepted, and whether the newest failed. */
interface ModeRequests {
	sessionId: string;
	sent: number;
	accepted: { order: number; mode: string | undefined };
	newestFailed: boolean;
}

const modeRequestsOf = (sessionId: string, mode: string | undefined): ModeRequests => ({
	sessionId,
	sent: 0,
	accepted: { order: 0, mode },
	newestFailed: false,
});

/** What the user chose for the session, on the command line or with the lists, which `/new` keeps. */
interface Chosen {
	model?: string;
	effort?: string;
	profile?: string;
	backend?: BackendName;
}

/** Whether a prompt can name the session in the terminal's title: a slash command does not. */
const namesSession = (prompt: string) => !prompt.trim().startsWith("/");

/** What the user sent in a saved session, in order: its prompts and the main agent's queued messages that entered. */
const sentTexts = (entries: readonly SavedEntry[]) =>
	entries.flatMap((entry) => {
		if (entry.type === "prompt") return [entry.text];
		if (entry.type === "event" && entry.event.type === "queued_message" && entry.event.parentCallId === undefined)
			return [entry.event.text];
		return [];
	});

/** The core refused the level chosen for a session it had just started. */
class EffortRefused extends Error {}

/**
 * Starts a session with what was chosen; the level has no place in `session.start`, so it is changed right after.
 * If that fails, the session just started is closed so that the core does not go on running it.
 */
async function startSession(
	link: CoreLink,
	args: CliArgs,
	chosen: Chosen,
	mode: PermissionMode | undefined,
): Promise<Opened> {
	const started = (await link.request({
		command: "session.start",
		cwd: args.cwd,
		userQuestions: { multiSelect: true, preview: true },
		// The TUI shows a job's end outside any turn (`session_event`).
		sessionEvents: true,
		...(chosen.model === undefined ? {} : { model: chosen.model }),
		...(chosen.backend === undefined ? {} : { backend: chosen.backend }),
		...(mode === undefined ? {} : { mode }),
		...(chosen.profile === undefined ? {} : { profile: chosen.profile }),
		...(args.noSession ? { noSession: true } : {}),
	})) as Opened;
	if (chosen.effort === undefined) return started;
	try {
		const configuration = (await link.request({
			command: "session.set_effort",
			sessionId: started.sessionId,
			effort: chosen.effort as Extract<ClientCommand, { command: "session.set_effort" }>["effort"],
		})) as SessionConfiguration;
		return { ...started, configuration };
	} catch (error) {
		await link.request({ command: "session.close", sessionId: started.sessionId }).catch(() => {});
		throw new EffortRefused(describeError(error));
	}
}

/** Resumes the saved session `savedId` and shows what it said; answers it as the core started it again. */
async function resumeSession(
	link: CoreLink,
	cwd: string,
	savedId: string,
	conversation: Conversation,
): Promise<Opened> {
	const resumed = (await link.request({
		command: "session.resume",
		sessionId: savedId,
		cwd,
		userQuestions: { multiSelect: true, preview: true },
		sessionEvents: true,
	})) as Opened & {
		name?: string;
		entries: JsonValue[];
	};
	const entries = resumed.entries as unknown as SavedEntry[];
	for (const part of savedParts(savedId, resumed.name, entries))
		if ("text" in part) conversation.plain(part.text);
		else if ("shell" in part) conversation.shellResult(part.shell);
		else conversation.answered(part.questions, part.outcome);
	const name = resumed.name ?? sentTexts(entries).find(namesSession);
	return {
		sessionId: resumed.sessionId,
		savedId,
		...(resumed.configuration === undefined ? {} : { configuration: resumed.configuration }),
		...(name === undefined ? {} : { name }),
	};
}

/** Starts or resumes the session the arguments ask for, or answers the message to fail with. */
async function openSession(
	link: CoreLink,
	args: CliArgs,
	chosen: Chosen,
	conversation: Conversation,
): Promise<Opened | { error: string }> {
	const mode = args.mode ?? (args.yes ? "normal" : undefined);
	if (!args.continueSession && args.resume === undefined) return startSession(link, args, chosen, mode);
	const { sessions } = (await link.request({ command: "sessions.list", cwd: args.cwd })) as {
		sessions: { id: string; backend: string; resumable: boolean }[];
	};
	const saved =
		args.resume === undefined
			? sessions.find((info) => info.resumable)
			: sessions.find((info) => info.id === args.resume);
	if (saved === undefined)
		return {
			error:
				args.resume === undefined
					? `No saved session to continue in ${args.cwd}.`
					: `No saved session ${args.resume} in ${args.cwd}.`,
		};
	const refused = resumeRefusal(args, saved.id, saved.backend);
	if (refused !== undefined) return { error: refused };
	const resumed = await resumeSession(link, args.cwd, saved.id, conversation);
	const { sessionId } = resumed;
	let { configuration } = resumed;
	// What the arguments ask for wins over what was saved, as at start.
	if (mode !== undefined) {
		await link.request({ command: "session.set_mode", sessionId, mode });
		if (configuration !== undefined) configuration = { ...configuration, permissionMode: mode };
	}
	if (args.profile !== undefined)
		configuration = (await link.request({
			command: "session.set_profile",
			sessionId,
			profile: args.profile,
		})) as SessionConfiguration;
	if (args.model !== undefined)
		configuration = (await link.request({
			command: "session.set_model",
			sessionId,
			model: args.model,
		})) as SessionConfiguration;
	return { ...resumed, ...(configuration === undefined ? {} : { configuration }) };
}

/**
 * The interactive session in the terminal's main screen: the core runs as a separate process and the TUI speaks the
 * protocol with it. The transcript scrolls with the terminal; the editor and the footer stay under it.
 */
export async function runTui(args: CliArgs, options: TuiOptions): Promise<number> {
	const paint = painter(options.color);
	const herdr = HerdrStatusReporter.fromEnv(options.env ?? {});
	const env: Record<string, string> = {
		...(args.noSandbox ? { ATELIER_SANDBOX: "off" } : {}),
		...(args.review ? {} : { ATELIER_REVIEW: "off" }),
		...(herdr === undefined ? {} : { [PANE_MARKER]: herdr.paneId }),
	};
	let link: CoreLink;
	try {
		link = await options.connect(env);
	} catch (error) {
		options.stderr(`error: The core could not start: ${describeError(error)}\n`);
		return EXIT_FAILED;
	}
	const settings = await readTuiSettings(options.home);
	const shade = new Shade(options.color);
	const tones = new Tones(options.color);
	let conversation = new Conversation(paint, args.cwd, shade, undefined, tones);
	conversation.view.liveThinking = !settings.hideThinking;
	// A wrong setting does not stop the session: it says what it used instead.
	for (const warning of settings.warnings) conversation.note(`warning: ${warning}`, true);
	let chosen: Chosen = {
		...(args.model === undefined ? {} : { model: args.model }),
		...(args.profile === undefined ? {} : { profile: args.profile }),
		...(args.explicitBackend === undefined ? {} : { backend: args.explicitBackend }),
	};
	let opened: Opened | { error: string };
	try {
		opened = await openSession(link, args, chosen, conversation);
	} catch (error) {
		opened = { error: describeError(error) };
	}
	if ("error" in opened) {
		await link.close();
		options.stderr(`error: ${opened.error}\n`);
		return EXIT_FAILED;
	}
	let { sessionId, savedId } = opened;
	/** What the terminal's title names the session by, and the title it was given last. */
	let titleName = opened.name;
	let titled: string | undefined;
	const showTitle = () => {
		const title = terminalTitle(args.cwd, titleName);
		if (title === titled) return;
		titled = title;
		options.terminal.setTitle(title);
	};
	/** Names the session by its first prompt that is not a slash command, unless it has a name already. */
	const titleWith = (prompt: string) => {
		if (titleName === undefined && namesSession(prompt)) titleName = prompt;
		showTitle();
	};

	const fullscreen = settings.fullscreen && !args.noFullscreen;
	const attention = new Attention(settings.notifications, { ...options, cwd: args.cwd });
	const tui = createScreen(attention.watch(options.terminal, fullscreen), fullscreen, paint);
	const footer = new Footer(
		paint,
		fullscreen ? settings.statusLine.filter((item) => FULLSCREEN_FOOTER_ITEMS.includes(item)) : settings.statusLine,
	);
	const version = options.version === undefined ? {} : { version: options.version };
	footer.place = { cwd: args.cwd, ...version };
	/** Refresh without blocking: only the latest read can update the screen, and none can outlive it. */
	let placeRead: AbortController | undefined;
	let changes: GitChanges = {};
	const readBranch = async () => {
		placeRead?.abort();
		const pending = new AbortController();
		placeRead = pending;
		const branch = await readGitBranch(args.cwd);
		if (pending.signal.aborted) return;
		footer.place = { cwd: args.cwd, ...version, ...(branch === undefined ? {} : { branch }) };
		changes = {};
		tui.requestRender();
		if (!fullscreen) return;
		const read = await readGitChanges(args.cwd, pending.signal);
		if (pending.signal.aborted) return;
		changes = read;
		tui.requestRender();
	};
	// What the core answered, until the session's own events say more.
	if (opened.configuration !== undefined) footer.state = footerWithConfiguration({}, opened.configuration);
	let modeRequests = modeRequestsOf(sessionId, footer.state.mode);
	// Each session gets a conversation of its own, after the ones before it.
	const transcript = new Container();
	transcript.addChild(conversation);
	const headerState = (): HeaderState => {
		const { model, backend, effort } = footer.state;
		const running = model ?? backend;
		return {
			cwd: args.cwd,
			...(options.home === undefined ? {} : { home: options.home }),
			...(options.version === undefined ? {} : { version: options.version }),
			...(running === undefined ? {} : { model: running }),
			...(effort === undefined ? {} : { effort }),
		};
	};
	const bar = new StatusBar(ink(activeTheme, options.color, getTerminalColorMode()), () => ({
		...footer.state,
		...footer.place,
		git: changes,
		cwd: args.cwd,
		...(options.home === undefined ? {} : { home: options.home }),
	}));
	// What scrolls and stays in the terminal on exit; fullscreen has no transcript header.
	const document = new Container();
	if (!fullscreen) document.addChild(new Header(paint, headerState));
	document.addChild(transcript);
	const status = new Container();
	// The ODD feature's tasks, over the questions and the editor.
	const odd = new Container();
	let feature = new FeaturePanel(paint);
	odd.addChild(feature);
	const dialogs = new Container();
	/** Questions waiting for an answer, the first one on screen. */
	const questions: {
		dialog: ChoiceDialog<string> | SecretDialog | PasteDialog | SearchDialog | AskDialog;
		cancel: () => void;
		local: boolean;
		/** The `ask_user` batch it shows: the core's `user_question_resolved` closes it without an answer. */
		userCallId?: string;
		/** Marks the batch closed, so that a late key or callback sends nothing. */
		drop?: () => void;
		blocked?: Blocked | undefined;
		told?: boolean;
	}[] = [];
	/** An open question takes every key: the editor is out of sight until it closes, and so is the queue's hint. */
	const questionOpen = () => questions.length > 0;
	const queue = new QueuePanel(paint, questionOpen);
	const editor = new PromptEditor(tui, editorTheme(paint), paint, shade, questionOpen);
	/** What `options.list` answered last, or is answering: the models `/model ` completes. */
	let listed: Promise<Options | undefined> = Promise.resolve(undefined);
	/** `/model ` lists the models of the providers signed in to, as `options.list` answered them last. */
	const completeModels = async (prefix: string): Promise<AutocompleteItem[] | null> => {
		const options = await listed;
		if (options === undefined) return null;
		const choices = modelChoices(options, footer.state.backend, footer.state.model);
		const found = fuzzyFilter(choices, prefix.trim(), (choice) => choice.value);
		return found.map(({ value, description }) => {
			const slash = value.indexOf("/");
			const notes = [value.slice(0, slash), ...(description === undefined ? [] : [description])];
			return { value, label: shown(value.slice(slash + 1)).text, description: notes.join(" · ") };
		});
	};
	const commands = COMMANDS.map((command) =>
		command.name === "model" ? { ...command, getArgumentCompletions: completeModels } : command,
	);
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, args.cwd, null));
	const loader = new Loader(
		tui,
		(text) => paint("cyan", text),
		(text) => paint("dim", text),
		"working… (Esc to interrupt)",
	);
	mount(
		tui,
		document,
		[
			{ component: status },
			{ component: odd },
			{ component: dialogs },
			{ component: queue },
			{ component: editor, editor: true, shown: () => !questionOpen() },
			{ component: footer },
		],
		fullscreen ? bar : undefined,
	);
	tui.setFocus(editor);

	let busy = false;
	/** The command typed after `!` that runs now, one at a time: `exited` settles when it ended, before its result is saved. */
	let shell: { abort: AbortController; exited: Promise<void> } | undefined;
	/** The results on their way to the core: quitting gives them a moment, a core that does not answer cannot hold it. */
	const saving = new Map<Promise<void>, Conversation>();
	let shellEpoch = 0;
	/** A slash command is still running (a list, a backend move, a new session starting): nothing else is sent. */
	let commanding = false;
	let interrupted = false;
	/** How many events of the session's turns the TUI has heard: one heard while a send waits shows a turn runs. */
	let heard = 0;
	let finish: (code: number) => void = () => {};
	const done = new Promise<number>((resolve) => {
		finish = resolve;
	});
	/** Follows every chunk of input, the editor's and the questions', so a paste stays one across them. */
	const input = new PasteFilter();
	/** The images pasted into the editor. */
	const pasted = new PromptImages();
	type ReadSource = "pasted file" | "clipboard image";
	/** Reads and pastes waiting in order, including clipboard reads that have not started yet. */
	const pendingReads: { source: ReadSource; abort: AbortController; discard: boolean }[] = [];
	let pastes = Promise.resolve();
	/** Changes when a session starts or Ctrl+C is pressed: a paste made before it is never inserted. */
	let pasteEpoch = 0;
	/** Where the editor's text and cursor stand for the pastes waiting: they insert only where they were made. */
	let pasteSpot = "";
	/** Ctrl+C, a new session, quitting and questions abort clipboard reads, including queued ones. */
	const abortClipboardReads = () => {
		for (const read of pendingReads) if (read.source === "clipboard image") read.abort.abort();
	};
	const spot = () => JSON.stringify([editor.getText(), editor.getCursor()]);
	const programStatus = new ProgramStatusReporter(options.terminal, options.statusIntervalMs);
	/** What the main agent is doing, the terminal's line for it. */
	let line = new StatusLine();
	/** Tells the terminal, and Herdr when the TUI runs in one of its panes, what the TUI is doing. */
	const reportState = (state: Parameters<ProgramStatusReporter["report"]>[0], blocked?: Blocked, message?: string) => {
		programStatus.report(
			state,
			blocked === undefined
				? { message }
				: { kind: blocked.kind === "permission" ? "permission" : "question", message: blocked.message },
		);
		herdr?.report(state, blocked);
	};
	/** Tells Herdr which session the TUI runs. */
	const reportSession = () => herdr?.session(savedId ?? sessionId, savedId !== undefined);
	/** What the terminal is told while a turn runs: blocked when the core's own question is on screen. */
	const reportRunning = () => {
		const blocked = questions[0]?.blocked;
		if (blocked) reportState("blocked", blocked);
		else if (busy) reportState("working", undefined, line.working());
	};

	const setBusy = (on: boolean) => {
		busy = on;
		// Enter queues while a turn runs; only a running slash command holds it.
		editor.disableSubmit = commanding;
		status.clear();
		if (on) {
			line.started();
			attention.turnStarted();
			reportRunning();
			status.addChild(loader);
			loader.start();
		} else loader.stop();
	};
	const showQuestion = () => {
		dialogs.clear();
		const first = questions[0];
		// The core's own question is told once, when it comes on screen.
		if (first?.blocked && !first.told) {
			first.told = true;
			attention.waiting(first.blocked.kind);
		}
		if (first) {
			dialogs.addChild(first.dialog);
			first.dialog.reveal();
			tui.setFocus(first.dialog);
		} else tui.setFocus(editor);
		tui.requestRender();
	};
	/** A question hides the draft: old clipboard work must never change it, even after the question closes. */
	const addQuestion = (entry: (typeof questions)[number]) => {
		let dropped = false;
		for (const read of pendingReads) {
			if (read.source !== "clipboard image" || read.discard) continue;
			read.discard = true;
			dropped = true;
		}
		abortClipboardReads();
		if (dropped) conversation.note("clipboard image dropped: a question opened; paste it again", true);
		questions.push(entry);
		if (questions.length === 1) showQuestion();
	};
	const ask = <T extends string>(
		question: {
			title: string;
			lines: string[];
			choices: Choice<T>[];
			initial: T;
			cancel: T;
			rows?: number;
			folded?: Folded;
			guardMs?: number;
		},
		answer: (value: T) => void,
		local = false,
		blocked?: Blocked,
	) => {
		let answered = false;
		const entry = {
			dialog: new ChoiceDialog({ ...question, paste: input }, paint, (value: T) => settle(value)),
			cancel: () => settle(question.cancel),
			local,
			blocked,
		};
		const settle = (value: T) => {
			if (answered) return;
			answered = true;
			const at = questions.indexOf(entry);
			if (at !== -1) questions.splice(at, 1);
			answer(value);
			showQuestion();
			reportRunning();
		};
		addQuestion(entry);
		reportRunning();
	};
	/**
	 * The rows a question may take: the terminal's, less those of the parts that stay on screen with it, and full screen
	 * the header and the transcript's row.
	 */
	const questionRows = () => {
		const width = options.terminal.columns;
		const others = [status, odd, queue, footer].reduce((rows, part) => rows + part.render(width).length, 0);
		return options.terminal.rows - others - (fullscreen ? bar.render(width).length + 1 : 0);
	};
	/**
	 * Asks an `ask_user` batch, its questions as tabs when there are several, and sends the answers once all are given;
	 * Esc or Ctrl+C sends `null`. The core's `user_question_resolved` closes it with nothing sent, so a late key answers
	 * nothing.
	 */
	const askUser = (callId: string, batch: Extract<AtelierEvent, { type: "user_question_requested" }>["questions"]) => {
		let closed = false;
		const asked = sessionId;
		// Each question's options as listed, the recommended one first.
		const ordered = batch.map((item) =>
			[...item.options].sort((a, b) => Number(b.recommended === true) - Number(a.recommended === true)),
		);
		const finish = (answers: UserAnswer[] | null) => {
			if (closed) return;
			closed = true;
			const at = questions.indexOf(entry);
			if (at !== -1) questions.splice(at, 1);
			if (asked === sessionId) void request({ command: "session.answer_user", sessionId, callId, answers });
			showQuestion();
			reportRunning();
		};
		/** The answers as the core takes them: the source id of each option chosen, or the user's own text. */
		const sent = (answers: AskAnswer[]): UserAnswer[] | null => {
			const given: UserAnswer[] = [];
			for (const [index, item] of batch.entries()) {
				const answer = answers[index];
				if (answer === undefined) return null;
				if ("options" in answer) {
					// The options checked, in the order the question lists them.
					const checked = new Set(answer.options.map((option) => ordered[index]?.[option]?.id));
					given.push({
						questionId: item.id,
						optionIds: item.options.filter((option) => checked.has(option.id)).map((option) => option.id),
						...(answer.other === undefined ? {} : { other: answer.other }),
					});
				} else if ("other" in answer) given.push({ questionId: item.id, other: answer.other });
				else {
					const chosen = ordered[index]?.[answer.option];
					if (chosen === undefined) return null;
					given.push({ questionId: item.id, optionId: chosen.id });
				}
			}
			return given;
		};
		const dialog = new AskDialog(
			{
				questions: batch.map((item, index) => ({
					...(item.header === undefined ? {} : { header: shown(item.header).text }),
					question: shown(item.question).text,
					...(item.multiSelect ? { multiSelect: true } : {}),
					options: (ordered[index] ?? []).map((option) => ({
						label: shown(option.label).text,
						...(option.description === undefined ? {} : { description: shown(option.description).text }),
						...(option.recommended ? { recommended: true } : {}),
						...(option.preview === undefined ? {} : { preview: shown(option.preview).text }),
					})),
				})),
				guardMs: options.answerGuardMs ?? ANSWER_GUARD_MS,
				paste: input,
				height: questionRows,
			},
			paint,
			(answers) => finish(answers === null ? null : sent(answers)),
		);
		const entry: (typeof questions)[number] = {
			dialog,
			cancel: () => finish(null),
			local: false,
			userCallId: callId,
			blocked: { kind: "user_question", message: "Questions from the agent" },
			drop: () => {
				closed = true;
			},
		};
		addQuestion(entry);
		reportRunning();
	};
	/** Drops the questions on screen: the core denied or dropped its own; the TUI's own lists close as with Esc. */
	const dropQuestions = () => {
		for (const dropped of questions.splice(0)) {
			dropped.drop?.();
			if (dropped.local) dropped.cancel();
		}
		showQuestion();
		reportRunning();
	};
	const request = (command: ClientCommand) =>
		link.request(command).catch((error: unknown) => {
			conversation.note(`error: ${describeError(error)}`, true);
			tui.requestRender();
			return undefined;
		});
	/** Shows a list starting on `now`; answers the value chosen, or nothing when Esc closes it or it is empty. */
	const pick = (title: string, lines: string[], choices: Choice<string>[], now?: string) =>
		new Promise<string | undefined>((resolve) => {
			const first = choices[0];
			if (first === undefined) return resolve(undefined);
			const initial = choices.some((choice) => choice.value === now) && now !== undefined ? now : first.value;
			ask(
				{ title, lines, choices, initial, cancel: CANCELLED, rows: LIST_ROWS },
				(value) => resolve(value === CANCELLED ? undefined : value),
				true,
			);
		});
	/** Asks for the options now, showing a failure as every request does; the answer is also what `/model ` completes. */
	const listOptions = async () => {
		const asked = request({ command: "options.list", cwd: args.cwd }) as Promise<Options | undefined>;
		listed = asked;
		return asked;
	};
	/**
	 * Asks again for the models in the background, as a sign-in may have changed them, for `/model ` to complete; a
	 * failure says nothing and leaves nothing to complete.
	 */
	const refreshModels = () => {
		listed = link.request({ command: "options.list", cwd: args.cwd }).then(
			(answer) => answer as Options,
			() => undefined,
		);
	};
	/** Sends a change of the session's configuration and shows in the footer what the core answered. */
	const configure = async (command: ClientCommand) => {
		const asked = sessionId;
		const answer = (await request(command)) as SessionConfiguration | undefined;
		// The answer of a session the TUI has left says nothing about the one running.
		if (answer === undefined || asked !== sessionId) return undefined;
		footer.state = footerWithConfiguration(footer.state, answer);
		return answer;
	};

	const onEvent = (id: string, event: AtelierEvent) => {
		if (id !== sessionId) return;
		heard++;
		// A queued message that starts a turn of its own is that turn's first event.
		if (event.type === "queued_message" && event.seq === 1 && !busy) {
			interrupted = false;
			setBusy(true);
		}
		// A queued message entering the conversation may be the session's first prompt.
		if (event.type === "queued_message" && event.parentCallId === undefined) titleWith(event.text);
		// Every event comes in a turn: a job's or a task's end with none running starts the turn its notice woke.
		if ((event.type === "job_finished" || event.type === "task_finished") && !busy) {
			interrupted = false;
			setBusy(true);
		}
		if (event.type === "queue_update") {
			queue.messages = event.messages;
			if (event.returned) giveBack(event.returned);
		}
		footer.state = footerAfter(footer.state, event);
		conversation.event(event);
		feature.event(event);
		line.event(event);
		// The main agent's task in progress, the footer's, goes to Herdr's sidebar.
		if (event.type === "feature_changed" && event.parentCallId === undefined)
			herdr?.activity(event.tasks.find((task) => task.status === "in_progress"));
		// A subagent asks the same user through the same session: its questions are asked like the main agent's.
		if (event.type === "approval_requested")
			ask(
				{
					...approvalQuestion(event),
					choices: approvalChoices(event),
					initial: "allow",
					cancel: "deny",
					guardMs: options.answerGuardMs ?? ANSWER_GUARD_MS,
				},
				(value) =>
					void request({
						command: "session.approve",
						sessionId,
						callId: event.callId,
						approved: value !== "deny",
						...(value === "session" || value === "project" || value === "always" ? { remember: value } : {}),
					}),
				false,
				{ kind: "permission", message: approvalQuestion(event).title },
			);
		else if (event.type === "user_question_requested") askUser(event.callId, event.questions);
		else if (event.type === "user_question_resolved") {
			// Closed at once, with whatever was typed in it: only this batch, and nothing is sent.
			const at = questions.findIndex((entry) => entry.userCallId === event.callId);
			if (at !== -1) {
				questions.splice(at, 1)[0]?.drop?.();
				showQuestion();
				reportRunning();
			}
		} else if (event.type === "review_consent_requested")
			ask(
				{
					title: CONSENT_TITLE,
					lines: [],
					choices: [
						{ value: "granted", label: "Review this change", description: "only this one" },
						{ value: "declined", label: "Skip this time", description: "the next one asks again" },
						{
							value: "granted_for_session",
							label: "Review all this session",
							description: "this one and later ones, without asking",
						},
					],
					initial: "granted",
					cancel: "declined",
					guardMs: options.answerGuardMs ?? ANSWER_GUARD_MS,
				},
				(answer) => void request({ command: "session.review_consent", sessionId, reviewId: event.reviewId, answer }),
				false,
				{ kind: "question", message: CONSENT_TITLE },
			);
		else if (event.type === "turn_finished" && event.parentCallId === undefined) {
			void readBranch();
			dropQuestions();
			setBusy(false);
			const settled = line.settled(event.stopReason);
			reportState(settled.state, undefined, settled.message);
			attention.turnFinished(event.stopReason);
		} else reportRunning();
		tui.requestRender();
	};

	let quitting = false;
	const quit = (code: number) => {
		if (quitting) return;
		quitting = true;
		abortClipboardReads();
		shell?.abort.abort();
		finish(code);
	};
	/** Why the TUI quit, said once the terminal is given back: in the alternate screen it would be wiped with it. */
	let farewell: string | undefined;
	const coreExited = (exit: CoreExit) => {
		if (quitting) return;
		farewell = `error: The core exited (${exit.signal ?? `exit code ${exit.code ?? "unknown"}`}).${exit.stderr ? `\n${exit.stderr}` : ""}\n`;
		quit(EXIT_FAILED);
	};
	/**
	 * Starts a turn with `command`, typed as `line`; `turnRefused` keeps what a `busy` refusal sends back. The TUI goes
	 * on running only a turn it heard of while it waited (a notice woke one before the core received the command): a
	 * change of mode in flight also refuses images as busy, with no turn running.
	 */
	const startTurn = async (command: ClientCommand, line: string) => {
		interrupted = false;
		setBusy(true);
		const heardBefore = heard;
		try {
			await link.request(command);
			return true;
		} catch (error) {
			const refused = error instanceof RpcError && error.code === "busy";
			if (!refused) conversation.note(`error: ${describeError(error)}`, true);
			if (!refused || heard === heardBefore) {
				setBusy(false);
				reportState("idle");
			}
			if (refused) turnRefused(command, line);
			tui.requestRender();
			return false;
		}
	};
	/** What a turn that started meanwhile refused: a prompt is queued as a steer, images and commands go back. */
	const turnRefused = (command: ClientCommand, line: string) => {
		if (command.command === "session.send" && command.images?.length) return conversation.note(IMAGES_BUSY, true);
		if (command.command === "session.send")
			return void queueLine(line, "steer").then((taken) => {
				if (!taken) return;
				conversation.note("a turn started meanwhile; the prompt was queued as a steer");
				tui.requestRender();
			});
		giveBack([line]);
		conversation.note(COMMAND_WAITS);
	};
	/** Puts queued messages back in the editor, before what it holds, each apart from the next by a blank line. */
	const giveBack = (messages: readonly (QueuedMessage | string)[]) => {
		const back = messages.map((message) => (typeof message === "string" ? message : message.text));
		const texts = [...back, editor.getText()].filter((text) => text.trim() !== "");
		if (texts.length > 0) editor.setText(texts.join("\n\n"));
	};
	/** Queues what was typed while a turn runs; a slash command waits in the editor for the turn to end. */
	const enqueue = (line: string, kind: QueueKind) => {
		const text = line.trim();
		if (text === "") return;
		if (pasted.has(line)) {
			editor.setText(line);
			return conversation.note(IMAGES_BUSY, true);
		}
		if (isStatsCommand(text)) return void submit(line);
		if (text.startsWith("/")) {
			editor.setText(line);
			return conversation.note(COMMAND_WAITS);
		}
		editor.addToHistory(line);
		editor.setText("");
		void queueLine(line, kind);
	};
	/** Queues `line`; answers whether the core took it. */
	const queueLine = (line: string, kind: QueueKind) => {
		const asked = sessionId;
		return request({ command: "session.queue", sessionId, kind, text: line }).then((answer) => {
			// Not taken, it goes back before whatever was typed meanwhile.
			if (answer !== undefined || asked !== sessionId) return answer !== undefined;
			giveBack([line]);
			tui.requestRender();
			return false;
		});
	};
	const takeBackQueue = async () => {
		const asked = sessionId;
		const answer = (await request({ command: "session.unqueue", sessionId })) as
			| { messages: QueuedMessage[] }
			| undefined;
		if (answer === undefined || asked !== sessionId) return;
		giveBack(answer.messages);
		tui.requestRender();
	};
	const interrupt = () => {
		interrupted = true;
		conversation.note("interrupting… (Ctrl+C again to quit)");
		dropQuestions();
		void request({ command: "session.interrupt", sessionId });
	};

	/**
	 * Changes the mode, shown in the footer at once. The core applies the requests in the order they were sent, so its
	 * mode is the last one it accepted; when the newest request fails, the footer shows that one.
	 */
	const setMode = async (mode: PermissionMode) => {
		const modes = modeRequests;
		const order = ++modes.sent;
		footer.state = footerWithMode(footer.state, mode);
		tui.requestRender();
		const ok = (await request({ command: "session.set_mode", sessionId: modes.sessionId, mode })) !== undefined;
		// A request of a session the TUI has left says nothing about the one running.
		if (modes !== modeRequests) return false;
		if (ok && order > modes.accepted.order) modes.accepted = { order, mode };
		if (!ok && order === modes.sent) modes.newestFailed = true;
		if (ok && order === modes.sent) modes.newestFailed = false;
		if (modes.newestFailed && modes.accepted.mode !== undefined)
			footer.state = footerWithMode(footer.state, modes.accepted.mode);
		tui.requestRender();
		return ok;
	};

	const runMode = async (words: string[]) => {
		const [, first, second] = words;
		if (first === undefined) {
			const modes = (await listOptions())?.modes;
			if (modes === undefined) return;
			const mode = await pick("Permission mode", [], modeChoices(modes, footer.state.mode), footer.state.mode);
			if (isMode(mode) && (await setMode(mode))) conversation.note(`mode: ${mode} (this session)`);
			return;
		}
		if (words.length === 2 && isMode(first)) {
			if (await setMode(first)) conversation.note(`mode: ${first} (this session)`);
			return;
		}
		if (words.length === 3 && first === "default" && isMode(second)) {
			if (options.home === undefined)
				return conversation.note("error: no home directory to save the default mode in", true);
			try {
				await writeDefaultPermissionMode(options.home, second);
			} catch (error) {
				return conversation.note(`error: could not save the default mode: ${describeError(error)}`, true);
			}
			return conversation.note(`default mode: ${second} (saved in ~/.atelier/permission-mode.json)`);
		}
		conversation.note("usage: /mode [normal|auto|yolo] | /mode default <normal|auto|yolo>", true);
	};

	/**
	 * Changes the model, chosen from the models of every provider signed in to or named `provider/model`: one of the
	 * session's backend changes at once, one of another moves the session there.
	 */
	const runModel = async (name: string | undefined) => {
		const { backend: on, model: now } = footer.state;
		let value = name;
		if (value === undefined) {
			const options = await listOptions();
			if (options === undefined) return;
			const choices = modelChoices(options, on, now);
			if (choices.length === 0) return conversation.note("no provider signed in: use /login to add one", true);
			const current = choices.find((choice) => choice.description?.startsWith("current"))?.value;
			value = await search("Select a model", MODEL_NOTE, "no model matches", choices, current);
			if (value === undefined) return;
		}
		const read = readModel(value);
		if (!read.ok) return conversation.note(`error: ${read.why}`, true);
		const { backend, model } = read.entry;
		// Only narrows the type: a name that reads well always names a model.
		if (model === undefined) return;
		if (backend !== undefined && backend !== on) return moveTo(backend, model);
		if (model === now) return conversation.note(`model: ${shown(model).text} (unchanged)`);
		if ((await configure({ command: "session.set_model", sessionId, model })) === undefined) return;
		chosen = { ...chosen, model };
		conversation.note(`model: ${shown(model).text} from the next turn; the prompt cache starts over`);
	};

	/** Moves the session to `model` on another backend once the user confirms that a summary replaces the conversation. */
	const moveTo = async (backend: BackendName, model: string) => {
		const { backend: from, model: now } = footer.state;
		const answer = await pick(
			`Move this session to ${backend}?`,
			[
				"The new backend gets a summary of the conversation, not the conversation itself:",
				"detail is lost, and the prompt cache starts over.",
			],
			[
				{ value: "move", label: "Move, with a summary" },
				{ value: "stay", label: `Stay on ${shown(from ?? "this backend").text}` },
			],
			"stay",
		);
		if (answer !== "move")
			return conversation.note(now === undefined ? "model: unchanged" : `model: ${shown(now).text} (unchanged)`);
		conversation.note(`moving to ${backend}: summarizing the conversation…`);
		tui.requestRender();
		const configuration = await configure({ command: "session.set_backend", sessionId, backend, model });
		if (configuration === undefined) return;
		chosen = { ...chosen, backend, model };
		reportSession();
		const carried = configuration.backendChange?.summarized
			? "with a summary of the conversation"
			: "nothing to carry yet";
		conversation.note(`backend: ${backend}, model: ${shown(model).text} from the next turn, ${carried}`);
	};

	const runEffort = async (level: string | undefined) => {
		const now = footer.state.effort;
		let effort = level;
		if (effort === undefined) {
			const efforts = (await listOptions())?.efforts;
			if (efforts === undefined) return;
			effort = await pick("Thinking level", [], choicesOf(efforts, now), now);
			if (effort === undefined) return;
		}
		const command = {
			command: "session.set_effort",
			sessionId,
			effort,
		} as Extract<ClientCommand, { command: "session.set_effort" }>;
		if ((await configure(command)) === undefined) return;
		chosen = { ...chosen, effort };
		conversation.note(`effort: ${shown(effort).text} from the next turn`);
	};

	const runProfile = async (name: string | undefined) => {
		let profile = name;
		if (profile === undefined) {
			const options = await listOptions();
			if (options === undefined) return;
			if (options.profiles.length === 0) return conversation.note("no profiles in ~/.atelier/profiles.json", true);
			const now = footer.state.profile;
			profile = await pick("Profile", [], profileChoices(options, now), now);
			if (profile === undefined) return;
		}
		if ((await configure({ command: "session.set_profile", sessionId, profile })) === undefined) return;
		chosen = { ...chosen, profile };
		conversation.note(`profile: ${shown(profile).text} from the next turn`);
	};

	/** Shows `next` in a conversation of its own and closes the session it replaces. */
	const switchTo = (next: Opened, shownIn: Conversation) => {
		const previous = sessionId;
		sessionId = next.sessionId;
		savedId = next.savedId;
		pasted.reset();
		pasteEpoch++;
		abortClipboardReads();
		titleName = next.name;
		showTitle();
		conversation = shownIn;
		queue.messages = [];
		footer.state = next.configuration === undefined ? {} : footerWithConfiguration({}, next.configuration);
		modeRequests = modeRequestsOf(sessionId, footer.state.mode);
		// The session before's feature says nothing about the next one; the panel stays as open as it was.
		const open = feature.open;
		odd.clear();
		feature = new FeaturePanel(paint);
		feature.open = open;
		odd.addChild(feature);
		herdr?.activity(undefined);
		line = new StatusLine();
		void request({ command: "session.close", sessionId: previous });
		reportSession();
	};
	/** A conversation for the next session, after a rule that ends the one before. */
	const nextConversation = (title: string) => {
		const next = new Conversation(paint, args.cwd, shade, undefined, tones);
		next.view.thinking = conversation.view.thinking === true;
		next.view.liveThinking = conversation.view.liveThinking !== false;
		next.addChild(new Text(paint("dim", `── ${title} ──`), 1, 1));
		transcript.addChild(next);
		return next;
	};
	const withoutConversation = (shownIn: Conversation) => transcript.removeChild(shownIn);

	/** Opens or folds the feature panel; with no feature active there is nothing to show. */
	const toggleFeature = () => {
		if (!feature.active) return conversation.note("no ODD feature is active in this session");
		feature.toggle();
	};

	/** `/mcp` prints the session's MCP servers as the core has them now; `/mcp login|logout <server>` signs one in or out first. */
	const runMcp = async (words: string[]) => {
		const [action, server, ...extra] = words;
		if (
			action !== undefined &&
			((action !== "login" && action !== "logout") || server === undefined || extra.length > 0)
		)
			return conversation.note("usage: /mcp | /mcp login <server> | /mcp logout <server>", true);
		try {
			if (action === "login" && server !== undefined) {
				conversation.note(
					`Signing in to ${shown(server).text}: the browser opens the authorization page; waiting for it…`,
				);
				tui.requestRender();
			}
			const command: ClientCommand =
				server === undefined
					? { command: "session.mcp", sessionId }
					: { command: action === "login" ? "session.mcp_login" : "session.mcp_logout", sessionId, server };
			const { servers, problems } = (await link.request(command)) as {
				servers: McpServerStatus[];
				problems: string[];
			};
			const report = mcpReport(servers, problems);
			if (report === "") conversation.note("No MCP servers in this session.");
			else conversation.plain(report);
		} catch (error) {
			conversation.note(`error: ${describeError(error)}`, true);
		}
	};

	/** `/permissions` lists the session's rules from the core; `/permissions remove <n>` removes the n-th of that list. */
	const runPermissions = async (words: string[]) => {
		const parsed = parsePermissions(words);
		if (parsed === undefined) return conversation.note(PERMISSIONS_USAGE, true);
		try {
			const { rules } = (await link.request({ command: "session.permissions", sessionId })) as {
				rules: (ShownRule & { id: string })[];
			};
			if (parsed.remove === undefined) return conversation.note(rulesListing(rules));
			const rule = rules[parsed.remove - 1];
			if (rule === undefined) return conversation.note(`error: no rule ${parsed.remove}`, true);
			await link.request({ command: "session.permissions_remove", sessionId, ruleId: rule.id });
			conversation.note(removedText(rule));
		} catch (error) {
			conversation.note(`error: ${describeError(error)}`, true);
		}
	};

	/** Reads a secret in a dialog over the editor, never on screen; undefined when Esc closes it. */
	/**
	 * Reads a secret as one more question: the editor hides, every key goes to it, and Esc, Ctrl+C or Ctrl+D close it
	 * with nothing. Only how many characters it has ever shows.
	 */
	const askSecret = (title: string) =>
		new Promise<string | undefined>((resolve) => {
			let answered = false;
			const settle = (value: string | undefined) => {
				if (answered) return;
				answered = true;
				const at = questions.indexOf(entry);
				if (at !== -1) questions.splice(at, 1);
				resolve(value);
				showQuestion();
				reportRunning();
			};
			const entry = { dialog: new SecretDialog(title, paint, settle), cancel: () => settle(undefined), local: true };
			addQuestion(entry);
		});
	/** Chooses from `choices` through a search line, as a question of the TUI's own; nothing when Esc closes it. */
	const search = (title: string, note: string, empty: string, choices: Choice<string>[], initial?: string) =>
		new Promise<string | undefined>((resolve) => {
			let answered = false;
			const settle = (value: string | undefined) => {
				if (answered) return;
				answered = true;
				const at = questions.indexOf(entry);
				if (at !== -1) questions.splice(at, 1);
				resolve(value);
				showQuestion();
				reportRunning();
			};
			const options = { title, note, empty, choices, initial, rows: LIST_ROWS };
			const entry = { dialog: new SearchDialog(options, paint, settle), cancel: () => settle(undefined), local: true };
			addQuestion(entry);
		});
	/** A line to paste, in a question that closes by itself when `signal` aborts (the browser finished first). */
	const askUntil = (title: string, signal: AbortSignal, hint?: string) =>
		new Promise<string | undefined>((resolve) => {
			let answered = false;
			const settle = (value: string | undefined) => {
				if (answered) return;
				answered = true;
				signal.removeEventListener("abort", stop);
				const at = questions.indexOf(entry);
				if (at !== -1) questions.splice(at, 1);
				resolve(value);
				showQuestion();
				reportRunning();
			};
			const stop = () => settle(undefined);
			const entry = { dialog: new PasteDialog(title, paint, settle, hint), cancel: stop, local: true };
			if (signal.aborted) return resolve(undefined);
			signal.addEventListener("abort", stop, { once: true });
			addQuestion(entry);
		});
	/** `/login` and `/logout`, as `atelier login` and `atelier logout` do, with lists and dialogs. Not a turn. */
	const runLogin = async (command: string, words: string[]) => {
		const target = parseLoginTarget(words);
		if (target === undefined)
			return conversation.note(`usage: ${command === "/login" ? LOGIN_USAGE : LOGOUT_USAGE}`, true);
		const ports: LoginPorts = {
			home: options.home ?? homedir(),
			env: options.env ?? {},
			...(options.claudeCode === undefined ? {} : { claudeCode: options.claudeCode }),
			...(options.runSecurity === undefined ? {} : { runSecurity: options.runSecurity }),
			interactive: true,
			choose: async (title, list) => {
				const choices = list.map(({ label, status }, index) => ({
					value: String(index),
					label,
					...(status === undefined ? {} : { description: status }),
				}));
				const chosen = await pick(title, [], choices);
				return chosen === undefined ? undefined : Number(chosen);
			},
			askSecret: (prompt) => askSecret(prompt.replace(/:\s*$/, "")),
			askUntil: (prompt, signal, hint) => askUntil(prompt.replace(/:\s*$/, ""), signal, hint),
			...options.openaiLogin,
			confirm: (question) =>
				new Promise((resolve) =>
					ask(
						{
							title: "Sign out?",
							lines: [question],
							choices: [
								{ value: "yes", label: "Sign out" },
								{ value: "no", label: "Cancel" },
							],
							initial: "no",
							cancel: "no",
						},
						(value) => resolve(value === "yes"),
						true,
					),
				),
			// Claude Code's sign-in gets the real terminal; Ctrl+C is its own until it ends, then the TUI draws itself again.
			handOver: async (task) => {
				tui.stop();
				const removeInterrupt = options.onInterrupt?.(() => {});
				try {
					return await task();
				} finally {
					removeInterrupt?.();
					tui.start();
					tui.requestRender(true);
				}
			},
			say: (text) => conversation.note(text),
			fail: (text) => conversation.note(`error: ${text}`, true),
		};
		await (command === "/login" ? login(ports, target) : logout(ports, target));
	};

	/** What the session runs with and loaded, which the transcript leaves out, and what it has cost so far. */
	const runStatus = () => {
		const lines = conversation.status();
		const { costUsd } = footer.state;
		const cost = costUsd === undefined ? "cost: none yet" : `cost: $${costUsd.toFixed(4)} this session`;
		const setup = lines.length === 0 ? ["the session says what it runs with at its first turn"] : lines;
		conversation.note([...setup, cost].join("\n"));
	};

	/** The conversations whose `/stats` is reading the saved sessions; each session reads one at a time. */
	const readingStats = new Set<Conversation>();
	/**
	 * Reads the saved sessions in the background, so the editor and a running turn go on; it says when it is done, in
	 * the conversation of the session it was asked in, even once `/new` or `/resume` moved on to another.
	 */
	const runStats = (words: readonly string[]) => {
		const shownIn = conversation;
		const asked = parseStatsCommand(words);
		if (asked === undefined) return shownIn.note(`usage: ${STATS_USAGE}`, true);
		if (readingStats.has(shownIn)) return shownIn.note("stats: still reading the saved sessions");
		readingStats.add(shownIn);
		shownIn.note("reading saved sessions…");
		void statsNote(asked, { home: options.home, cwd: args.cwd, savedId }, Date.now())
			.then(
				({ text, warn }) => shownIn.note(text, warn),
				(error: unknown) => shownIn.note(`error: ${describeError(error)}`, true),
			)
			.finally(() => {
				readingStats.delete(shownIn);
				tui.requestRender();
			});
	};

	/** Starts a new session with what was chosen and the mode in use; the one before stays on screen. */
	const runNew = async () => {
		const mode = isMode(footer.state.mode) ? footer.state.mode : undefined;
		await stopShell();
		const shownIn = nextConversation("new session");
		try {
			switchTo(await startSession(link, args, chosen, mode), shownIn);
		} catch (error) {
			withoutConversation(shownIn);
			// A level the core refused is not asked for again by the next /new.
			if (error instanceof EffortRefused) {
				const { effort: _effort, ...rest } = chosen;
				chosen = rest;
			}
			return conversation.note(`error: ${describeError(error)}`, true);
		}
	};

	/** Resumes a saved session of the folder, chosen from a list when no id is given; the one running is not listed. */
	const runResume = async (id: string | undefined) => {
		let chosenId = id;
		if (chosenId === undefined) {
			const listed = (await request({ command: "sessions.list", cwd: args.cwd })) as
				| { sessions: SavedSessionInfo[] }
				| undefined;
			if (listed === undefined) return;
			const choices = sessionChoices(listed.sessions, savedId, Date.now());
			if (choices.length === 0) return conversation.note("no other saved session to resume in this folder");
			chosenId = await pick("Resume a session", [], choices);
			if (chosenId === undefined) return;
		}
		if (chosenId === savedId) return conversation.note(`session ${shown(chosenId).text} is the one running`);
		await stopShell();
		const shownIn = nextConversation("resumed session");
		try {
			switchTo(await resumeSession(link, args.cwd, chosenId, shownIn), shownIn);
		} catch (error) {
			withoutConversation(shownIn);
			return conversation.note(`error: ${describeError(error)}`, true);
		}
		// The saved session brings back its own model, level, profile and backend.
		chosen = {};
	};

	/** `/rename <name>` names the saved session, within the length the core takes; the title follows. */
	const runRename = async (name: string) => {
		if (name === "") return conversation.note(`usage: ${RENAME_USAGE}`, true);
		if (savedId === undefined) return conversation.note("error: this session is not saved; it has no name", true);
		const renamed = await request({ command: "session.rename", sessionId: savedId, cwd: args.cwd, name });
		if (renamed === undefined) return;
		titleName = name;
		showTitle();
		conversation.note(`session renamed to ${shown(name).text}`);
	};

	/**
	 * Sends a draft with images as a prompt. The editor is emptied here, as Enter has done and Alt+Enter has not, so
	 * whatever is typed meanwhile stays, and a draft the core does not take comes back before it.
	 */
	const sendImages = async (line: string) => {
		editor.setText("");
		if (line.trim().startsWith("/")) {
			editor.setText(line);
			return conversation.note("error: images can only be sent with a prompt, not a command", true);
		}
		let draft: ImageDraft | undefined;
		try {
			draft = pasted.attach(line);
		} catch (error) {
			editor.setText(line);
			return conversation.note(`error: ${describeError(error)}`, true);
		}
		if (draft === undefined) return giveBack([line]);
		const asked = sessionId;
		conversation.prompt(line);
		if (draft.prompt.trim() !== "") titleWith(draft.prompt.trim());
		commanding = true;
		editor.disableSubmit = true;
		try {
			const taken = await startTurn(
				{ command: "session.send", sessionId, prompt: draft.prompt, images: draft.images },
				line,
			);
			// The session it was for is gone, and its images with it.
			if (quitting || asked !== sessionId) return;
			if (taken) return pasted.release(draft);
			pasted.keep(draft);
			giveBack([line]);
			tui.requestRender();
		} finally {
			commanding = false;
			editor.disableSubmit = false;
		}
	};
	/** Aborts the running shell command and waits for it to end, as a session move does; its result is saved on its own. */
	const stopShell = async () => {
		shellEpoch++;
		shell?.abort.abort();
		await shell?.exited;
	};
	/**
	 * Runs a command the user typed, outside the agent, now even during a turn. It shows live output in one block and
	 * only the result goes to the core, once: a result that cannot be saved is reported and the command never reruns.
	 */
	const runShellCommand = (command: string, exclude: boolean) => {
		const asked = sessionId;
		const shownIn = conversation;
		const abort = new AbortController();
		const block = shownIn.shell(command, exclude);
		const redraw = () => {
			if (!quitting) tui.requestRender();
		};
		const running = (options.runShell ?? runUserShell)(command, {
			cwd: args.cwd,
			signal: abort.signal,
			onOutput: (text) => {
				block.output(text);
				redraw();
			},
		}).catch(
			(error: unknown): UserShellResult => ({
				output: "",
				exitCode: null,
				cancelled: false,
				truncated: false,
				error: describeError(error),
			}),
		);
		const save = async (result: UserShellResult) => {
			try {
				await link.request({
					command: "session.shell_result",
					sessionId: asked,
					result: { executionId: randomUUID(), command, excludeFromContext: exclude, ...result },
				});
			} catch (error) {
				shownIn.note(`error: could not save the shell result: ${describeError(error)}`, true);
			}
			redraw();
		};
		const own = {
			abort,
			exited: running.then((result) => {
				block.finish(result);
				if (shell === own) shell = undefined;
				const saved = save(result).finally(() => saving.delete(saved));
				saving.set(saved, shownIn);
				redraw();
			}),
		};
		shell = own;
	};
	/** `!command` and `!!command` run in the shell; a draft with images, or while one runs, stays in the editor. */
	const submitShell = (line: string, typed: { command: string; exclude: boolean }) => {
		// A slash command is moving the session: keep the draft, as Enter does, so it cannot run in the old one.
		if (commanding) return;
		if (pasted.has(line)) {
			editor.setText(line);
			return conversation.note(SHELL_IMAGES, true);
		}
		if (shell !== undefined) {
			editor.setText(line);
			return conversation.note(SHELL_BUSY, true);
		}
		editor.addToHistory(line);
		editor.setText("");
		runShellCommand(typed.command, typed.exclude);
		tui.requestRender();
	};
	const submit = async (line: string): Promise<void> => {
		const typed = parseShell(line);
		if (typed !== undefined) return submitShell(line, typed);
		const text = line.trim();
		// Completed results must reach the core before a new prompt; session controls never wait for that write.
		if (!busy && !commanding && text !== "" && !isStatsCommand(text) && !/^\/(?:new|resume|exit)(?:\s|$)/.test(text)) {
			const pending = [...saving].filter(([, shownIn]) => shownIn === conversation).map(([saved]) => saved);
			if (pending.length > 0) {
				const epoch = shellEpoch;
				editor.setText("");
				await Promise.all(pending);
				if (quitting || epoch !== shellEpoch) return;
				if (commanding) return giveBack([line]);
				const draft = editor.getExpandedText();
				editor.setText("");
				const submitted = submit(line);
				// Submitting clears the editor; keep anything typed while the save was pending, after any refused prompt.
				editor.setText([editor.getExpandedText(), draft].filter((text) => text !== "").join("\n\n"));
				tui.requestRender();
				return submitted;
			}
		}
		if (pasted.has(line)) {
			if (commanding) return;
			if (busy) return enqueue(line, "steer");
			return sendImages(line);
		}
		// It only reads the saved sessions, so it runs at any time, a turn or a command running or not.
		if (isStatsCommand(text)) {
			editor.addToHistory(line);
			editor.setText("");
			conversation.prompt(line);
			runStats(text.split(/\s+/).slice(1));
			return tui.requestRender();
		}
		if (busy && !commanding) return enqueue(line, "steer");
		if (text === "" || busy || commanding) return;
		editor.addToHistory(line);
		editor.setText("");
		if (text === "/exit") return quit(EXIT_OK);
		conversation.prompt(line);
		commanding = true;
		editor.disableSubmit = true;
		try {
			await dispatch(text, line);
		} finally {
			commanding = false;
			editor.disableSubmit = false;
		}
		tui.requestRender();
	};
	/** The commands that take no more than the arguments in their usage; with others they print it. */
	const usages = new Map([
		["/model", "/model [provider/model]"],
		["/effort", "/effort [level]"],
		["/profile", "/profile [name]"],
		["/new", "/new"],
		["/feature", "/feature"],
		["/mcp", "/mcp [login|logout <server>]"],
		["/status", "/status"],
		["/resume", "/resume [id]"],
		["/undo-correction", "/undo-correction"],
		["/review", "/review [ref]"],
	]);
	const dispatch = async (text: string, line: string) => {
		const words = text.split(/\s+/);
		const [command, argument] = words;
		const single = words.length <= 2;
		if (command === "/mode") await runMode(words);
		else if (command === "/model" && single) await runModel(argument);
		else if (command === "/effort" && single) await runEffort(argument);
		else if (command === "/profile" && single) await runProfile(argument);
		else if (text === "/new") await runNew();
		else if (text === "/feature") toggleFeature();
		else if (command === "/mcp") await runMcp(words.slice(1));
		else if (command === "/permissions") await runPermissions(words.slice(1));
		// Gone: the model list moves a session to another provider now.
		else if (command === "/backend") conversation.note(BACKEND_GONE, true);
		else if (command === "/login" || command === "/logout") {
			await runLogin(command, words.slice(1));
			// A sign-in adds its provider's models to /model, a sign-out takes them away.
			refreshModels();
		} else if (text === "/status") runStatus();
		else if (command === "/resume" && single) await runResume(argument);
		else if (command === "/rename") await runRename(text.slice(command.length).trim());
		else if (text === "/undo-correction") await startTurn({ command: "session.undo_correction", sessionId }, line);
		else if (/^\/review(?:\s+\S+)?$/.test(text))
			await startTurn(
				{ command: "session.review", sessionId, ...(words[1] === undefined ? {} : { ref: words[1] }) },
				line,
			);
		else if (/^\/compact(?:\s|$)/.test(text)) {
			const instructions = text.slice("/compact".length).trim();
			await startTurn(
				{ command: "session.compact", sessionId, ...(instructions === "" ? {} : { instructions }) },
				line,
			);
		} else if (usages.has(command ?? "")) conversation.note(`usage: ${usages.get(command ?? "")}`, true);
		else {
			titleWith(line);
			await startTurn({ command: "session.send", sessionId, prompt: line }, line);
		}
	};
	// A shell command keeps the bytes after its marker: the editor trims what it submits, and the command's tail may matter.
	editor.onSubmit = (line) => {
		const raw = editor.untrimmed;
		void submit(raw.trim() === line && parseShell(line) !== undefined ? raw : line);
	};
	/**
	 * Runs `prepare` behind the reads ahead of it and inserts the images it yields at the cursor; `none` runs when it
	 * yields none. A read made before an edit, a move or a new session is dropped, never merged.
	 */
	const queueRead = (
		source: ReadSource,
		prepare: ((signal: AbortSignal) => Promise<PreparedImage[] | undefined>) | undefined,
		none: () => void,
	) => {
		if (pendingReads.length === 0) pasteSpot = spot();
		const epoch = pasteEpoch;
		const stale = () => quitting || epoch !== pasteEpoch || spot() !== pasteSpot;
		const read = { source, abort: new AbortController(), discard: false };
		pendingReads.push(read);
		pastes = pastes.then(async () => {
			let prepared: PreparedImage[] | undefined;
			let failure: unknown;
			if (prepare !== undefined && !stale() && !read.discard) {
				try {
					prepared = await prepare(read.abort.signal);
				} catch (error) {
					failure = error;
				}
			}
			pendingReads.shift();
			if (quitting || read.discard) return;
			if (stale()) conversation.note("pasted text dropped: the draft changed while it was read; paste it again", true);
			else if (failure !== undefined) conversation.note(`error: ${describeError(failure)}`, true);
			else if (prepared === undefined) none();
			else {
				try {
					const marker = pasted.add(editor.getText(), prepared);
					editor.insertTextAtCursor(marker);
					pasteSpot = spot();
					if (prepared.some((one) => one.animated)) conversation.note(ANIMATED);
				} catch (error) {
					conversation.note(`error: ${describeError(error)}`, true);
				}
			}
			tui.requestRender();
		});
	};
	const readPaste = (text: string) => {
		const plain = () => editor.handleInput(`${PASTE_START}${text}${PASTE_END}`);
		const mayBeFile = text.length <= PATH_PASTE_CHARS && /[\\/]|\.\w+['"]?(\s|$)/.test(text.trim());
		// Text that cannot name a file goes in at once, unless a read is ahead of it.
		if (pendingReads.length === 0 && !mayBeFile) return plain();
		const prepare = (_signal: AbortSignal) =>
			preparePastedImages(text, {
				cwd: args.cwd,
				...(options.home === undefined ? {} : { home: options.home }),
			});
		queueRead("pasted file", mayBeFile ? prepare : undefined, () => {
			plain();
			pasteSpot = spot();
		});
	};
	/** Ctrl+V: the clipboard's image, read in the order of the pastes; the clipboard's text is the terminal's to paste. */
	const readClipboard = () => {
		if ((options.platform ?? process.platform) !== "darwin") return conversation.note(CLIPBOARD_UNSUPPORTED);
		const read = options.readClipboardImage ?? readClipboardImage;
		queueRead(
			"clipboard image",
			async (signal) => {
				const bytes = await read(signal);
				signal.throwIfAborted();
				return bytes === undefined ? undefined : [await normalizeImage(bytes, { clipboard: true })];
			},
			() => conversation.note(NO_CLIPBOARD_IMAGE),
		);
	};
	const waitForPaste = (source: ReadSource) => {
		conversation.note(`still reading the ${source}; press Enter again in a moment`);
		tui.requestRender();
		return { consume: true as const };
	};

	// An open question takes every key, and Ctrl+C or Ctrl+D closes it. Otherwise Ctrl+C interrupts a turn, then quits;
	// with no turn it clears the editor, then quits. Esc interrupts a turn, and Ctrl+D quits from an empty editor.
	const handleKey = (data: string) => {
		const pending = pendingReads[0];
		if (questions.length === 0 && pending !== undefined && (matchesKey(data, "enter") || matchesKey(data, "alt+enter")))
			return waitForPaste(pending.source);
		// Nothing but the open question takes the keys, even after a click elsewhere.
		const asked = questions[0];
		if (asked !== undefined && !asked.dialog.focused) tui.setFocus(asked.dialog);
		// Ctrl+C and Ctrl+D close an open question as Esc does, and do nothing else: the hidden editor keeps what it holds,
		// the turn goes on and the TUI stays.
		if (asked !== undefined && (matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d"))) {
			asked.cancel();
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+c")) {
			pasteEpoch++;
			abortClipboardReads();
			if (busy && !interrupted) interrupt();
			else if (!busy && editor.getText() !== "") editor.setText("");
			else quit(EXIT_INTERRUPTED);
			tui.requestRender();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+v") && questions.length === 0) {
			readClipboard();
			tui.requestRender();
			return { consume: true };
		}
		// Questions take Esc first; otherwise it stops a running command, then clears a shell draft.
		if (matchesKey(data, "escape") && questions.length === 0 && shell !== undefined) {
			shell.abort.abort();
			tui.requestRender();
			return { consume: true };
		}
		if (
			matchesKey(data, "escape") &&
			questions.length === 0 &&
			parseShell(editor.getText()) !== undefined &&
			!editor.isShowingAutocomplete()
		) {
			editor.setText("");
			tui.requestRender();
			return { consume: true };
		}
		if (
			matchesKey(data, "escape") &&
			busy &&
			!interrupted &&
			questions.length === 0 &&
			!editor.isShowingAutocomplete()
		) {
			interrupt();
			tui.requestRender();
			return { consume: true };
		}
		// Alt+Enter queues a follow-up while a turn runs, and sends like Enter when none does.
		if (matchesKey(data, "alt+enter") && questions.length === 0) {
			const line = editor.getExpandedText();
			if (busy && !commanding && parseShell(line) === undefined) enqueue(line, "follow_up");
			else void submit(line);
			tui.requestRender();
			return { consume: true };
		}
		// Shift+Up works in terminals that do not send Option as Alt, and leaves Up to the editor's history.
		const takeBack = matchesKey(data, "shift+up") || matchesKey(data, "alt+up");
		if (takeBack && questions.length === 0 && queue.messages.length > 0) {
			void takeBackQueue();
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+d") && !busy && editor.getText() === "") {
			quit(EXIT_OK);
			return { consume: true };
		}
		// Shift+Tab takes the mode between normal and auto; yolo is only chosen by name.
		if (matchesKey(data, "shift+tab") && questions.length === 0) {
			void setMode(nextMode(footer.state.mode));
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+o")) {
			// An open question with folded lines takes Ctrl+O; otherwise it opens or folds the cards.
			if (!questions[0]?.dialog.toggle()) conversation.toggleCards();
			tui.requestRender(true);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+r")) {
			conversation.toggleThinking();
			tui.requestRender(true);
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+t")) {
			toggleFeature();
			tui.requestRender();
			return { consume: true };
		}
		return undefined;
	};
	const removeKeys = tui.addInputListener((data) => {
		// While a question is open, it reads the input through the same filter: a paste begun before it stays a paste.
		if (questions.length !== 0) return handleKey(data);
		const wasPasting = input.pasting;
		const parts: (string | { paste: string })[] = [];
		input.read(data, { keys: (keys) => parts.push(keys), keep: () => true, pasted: (paste) => parts.push({ paste }) });
		const keys = parts.filter((part) => typeof part === "string");
		// Whole keys, or the end of a marker cut by the chunk, go the way they always did.
		if (!wasPasting && !input.pasting && keys.length === parts.length && keys.join("") === data) return handleKey(data);
		// A paste is the editor's alone: its keys answer nothing, and a path in it may be an image. The keys beside it
		// take the shortcuts, one by one, in the order they came.
		for (const part of parts) {
			if (typeof part !== "string") readPaste(part.paste);
			else for (const key of part.match(KEYS) ?? []) if (handleKey(key) === undefined) editor.handleInput(key);
		}
		tui.requestRender();
		return { consume: true };
	});

	const removeEvents = link.onEvent(onEvent);
	// A job's end outside any turn changes the footer and shows its line; no turn runs for it.
	const removeSessionEvents = link.onSessionEvent?.((id, body) => {
		if (id !== sessionId) return;
		const event = { ...body, seq: 0, turnId: "" } as AtelierEvent;
		footer.state = footerAfter(footer.state, event);
		conversation.event(event);
		tui.requestRender();
	});
	const removeExit = link.onExit(coreExited);
	const removeTerminate = options.onTerminate?.((signal) => quit(SIGNAL_EXIT + signal));
	tui.start();
	void readBranch();
	// The terminal's colors only refine the shade and make the cards' backgrounds: a question or an answer that fails
	// leaves the palette's shade and no backgrounds.
	if (shade.on) {
		const matchTerminalColors = (colors: TerminalColors) => {
			if (quitting) return;
			try {
				shade.match(colors.background, getTerminalColorMode());
				tones.match(colors.background, getTerminalColorMode());
			} catch {
				return;
			}
			tui.requestRender(true);
		};
		void tui
			.queryTerminalColors({ timeoutMs: COLOR_QUERY_MS, onLateReply: matchTerminalColors })
			.then(matchTerminalColors)
			.catch(() => {});
	}
	showTitle();
	// Before the first prompt, not at its failure: what the backend lacks, and how to get it.
	const startedOn = footer.state.backend;
	if (startedOn !== undefined && options.checkLogin !== undefined) {
		const shownIn = conversation;
		void options
			.checkLogin(startedOn)
			.catch(() => undefined)
			.then((missing) => {
				if (missing === undefined || quitting) return;
				shownIn.note(`warning: ${missing}`, true);
				tui.requestRender();
			});
	}
	refreshModels();
	// The state first: Herdr takes a resume command only from a reporter that holds the pane.
	reportState("idle");
	reportSession();
	try {
		return await done;
	} finally {
		removeKeys();
		removeEvents();
		removeSessionEvents?.();
		removeExit();
		removeTerminate?.();
		placeRead?.abort();
		loader.stop();
		programStatus.clear();
		// The editor and the footer stay behind; the transcript is printed where the terminal was.
		keepDocument(tui, document);
		const released = herdr?.release();
		tui.stop();
		if (farewell !== undefined) options.stderr(farewell);
		// The command ends before the session closes; its result is saved too, if the core answers in time.
		await shell?.exited;
		// A core that does not answer must not keep the terminal's owner waiting: close the link anyway.
		let timer: NodeJS.Timeout | undefined;
		const gaveUp = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
		});
		await Promise.race([Promise.all(saving.keys()), gaveUp]);
		await Promise.race([link.request({ command: "session.close", sessionId }).catch(() => {}), gaveUp]);
		clearTimeout(timer);
		await Promise.all([link.close(), released]);
	}
}
