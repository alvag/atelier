import {
	type AtelierEvent,
	type ClientCommand,
	describeError,
	type JsonValue,
	type PermissionMode,
	type SavedEntry,
	type SavedSessionInfo,
	type SessionConfiguration,
	visibleText,
	writeDefaultPermissionMode,
} from "@atelier/core";
import type { CoreExit } from "@atelier/core/client";
import { BACKEND_NAMES, type BackendName } from "@atelier/core/protocol";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	Loader,
	matchesKey,
	type Terminal,
	Text,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { CliArgs } from "../args.ts";
import { savedTranscript } from "../transcript.ts";
import { Conversation } from "./conversation.ts";
import { type Choice, ChoiceDialog } from "./dialog.ts";
import { type FooterState, footerAfter, footerLine, footerWithConfiguration, footerWithMode } from "./footer.ts";
import {
	choicesOf,
	LIST_ROWS,
	modeChoices,
	nextMode,
	type Options,
	profileChoices,
	sessionChoices,
} from "./selectors.ts";
import { editorTheme, type Paint, painter } from "./style.ts";

/** The core as the TUI talks to it: `RpcClient`, or an in-process server in tests. */
export interface CoreLink {
	request(command: ClientCommand): Promise<unknown>;
	onEvent(listener: (sessionId: string, event: AtelierEvent) => void): () => void;
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
	/** Registers a handler for SIGTERM and SIGHUP, given the signal's number; returns a function that removes it. */
	onTerminate?: (handler: (signal: number) => void) => () => void;
	/** How long closing the session may take before the core is closed anyway (default 3000 ms). */
	closeTimeoutMs?: number;
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_INTERRUPTED = 130;
const SIGNAL_EXIT = 128;
const CLOSE_TIMEOUT_MS = 3000;

const COMMANDS = [
	{ name: "model", description: "Change the model from the next turn [name]" },
	{ name: "effort", description: "Change the thinking level from the next turn [level]" },
	{ name: "profile", description: "Freeze another profile for this session [name]" },
	{ name: "mode", description: "Change the permission mode: [normal|auto|yolo] | default <mode>" },
	{ name: "backend", description: "Move the session to another backend, with a summary [name]" },
	{ name: "new", description: "Start a new session" },
	{ name: "resume", description: "Resume a saved session of this folder [id]" },
	{ name: "review", description: "Review the current changes, against HEAD or a git ref" },
	{ name: "undo-correction", description: "Undo the latest escalated review's correction" },
	{ name: "compact", description: "Summarize the older history now [instructions]" },
	{ name: "exit", description: "Close the session" },
];

/** The answer a list gives when Esc closes it. */
const CANCELLED = "\0";

const shown = (text: string) => visibleText(text);
const isMode = (word: string | undefined): word is PermissionMode =>
	word === "normal" || word === "auto" || word === "yolo";
const isBackend = (word: string | undefined): word is BackendName => BACKEND_NAMES.some((name) => name === word);

/** ` (asked by worker)` for a subagent's question; the main agent's says nothing. */
const asker = (event: AtelierEvent) =>
	event.parentCallId === undefined
		? ""
		: ` (asked by ${event.agent === undefined ? "a subagent" : shown(event.agent).text})`;

/** The question an approval asks, worded as the CLI's yes/no question. */
function approvalQuestion(event: Extract<AtelierEvent, { type: "approval_requested" }>): {
	title: string;
	lines: string[];
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
	const reason = event.reason === undefined ? undefined : shown(event.reason);
	const guard = event.confirm === undefined ? "" : ` (guard: ${shown(event.confirm).text})`;
	const warning =
		command.hadHidden || reason?.hadHidden
			? ["warning: the command contains invisible or control characters, shown as markers."]
			: [];
	return {
		title: `${reason ? "Run this command OUTSIDE the sandbox?" : "Run this command?"}${guard}${asker(event)}`,
		lines: [command.text, ...(reason ? [`reason: ${reason.text}`] : []), ...warning],
	};
}

function consentQuestion(event: Extract<AtelierEvent, { type: "review_consent_requested" }>): string[] {
	const why = event.lensesReason === undefined ? "" : ` (${shown(event.lensesReason).text})`;
	return [
		`risk: ${shown(event.level).text}`,
		`reasons: ${event.reasons.map((reason) => shown(reason).text).join("; ")}`,
		`lenses: ${event.lenses.map((lens) => shown(lens).text).join(", ")}${why}`,
	];
}

/** The fixed line under the editor. */
class Footer implements Component {
	state: FooterState = {};
	readonly #paint: Paint;
	constructor(paint: Paint) {
		this.#paint = paint;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return [footerLine(this.state, width, this.#paint)];
	}
}

/** A session the TUI runs: its id in the core, its file's id when it is saved, and what its next turn runs with. */
interface Opened {
	sessionId: string;
	savedId?: string;
	configuration?: SessionConfiguration;
}

/** What the user chose for the session, on the command line or with the lists, which `/new` keeps. */
interface Chosen {
	model?: string;
	effort?: string;
	profile?: string;
	backend?: BackendName;
}

/** Starts a session with what was chosen; the level has no place in `session.start`, so it is changed right after. */
async function startSession(
	link: CoreLink,
	args: CliArgs,
	chosen: Chosen,
	mode: PermissionMode | undefined,
): Promise<Opened> {
	const started = (await link.request({
		command: "session.start",
		cwd: args.cwd,
		...(chosen.model === undefined ? {} : { model: chosen.model }),
		...(chosen.backend === undefined ? {} : { backend: chosen.backend }),
		...(mode === undefined ? {} : { mode }),
		...(chosen.profile === undefined ? {} : { profile: chosen.profile }),
		...(args.noSession ? { noSession: true } : {}),
	})) as Opened;
	if (chosen.effort === undefined) return started;
	const configuration = (await link.request({
		command: "session.set_effort",
		sessionId: started.sessionId,
		effort: chosen.effort as Extract<ClientCommand, { command: "session.set_effort" }>["effort"],
	})) as SessionConfiguration;
	return { ...started, configuration };
}

/** Resumes the saved session `savedId` and shows what it said; answers it as the core started it again. */
async function resumeSession(
	link: CoreLink,
	cwd: string,
	savedId: string,
	conversation: Conversation,
): Promise<Opened> {
	const resumed = (await link.request({ command: "session.resume", sessionId: savedId, cwd })) as Opened & {
		name?: string;
		entries: JsonValue[];
	};
	conversation.plain(savedTranscript(savedId, resumed.name, resumed.entries as unknown as SavedEntry[]));
	return {
		sessionId: resumed.sessionId,
		savedId,
		...(resumed.configuration === undefined ? {} : { configuration: resumed.configuration }),
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
	if (args.explicitBackend !== undefined && args.explicitBackend !== saved.backend)
		return {
			error: `Session ${saved.id} was saved on ${saved.backend}; --backend ${args.explicitBackend} cannot resume it.`,
		};
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
	const env: Record<string, string> = {
		...(args.noSandbox ? { ATELIER_SANDBOX: "off" } : {}),
		...(args.review ? {} : { ATELIER_REVIEW: "off" }),
	};
	let link: CoreLink;
	try {
		link = await options.connect(env);
	} catch (error) {
		options.stderr(`error: The core could not start: ${describeError(error)}\n`);
		return EXIT_FAILED;
	}
	let conversation = new Conversation(paint, args.cwd);
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

	const tui = new TuiMainScreen(options.terminal);
	const footer = new Footer(paint);
	// What the core answered, until the session's own events say more.
	if (opened.configuration !== undefined) footer.state = footerWithConfiguration({}, opened.configuration);
	// Each session gets a conversation of its own, after the ones before it.
	const transcript = new Container();
	transcript.addChild(conversation);
	const status = new Container();
	const dialogs = new Container();
	const editor = new Editor(tui, editorTheme(paint));
	editor.setAutocompleteProvider(new CombinedAutocompleteProvider(COMMANDS, args.cwd, null));
	const loader = new Loader(
		tui,
		(text) => paint("cyan", text),
		(text) => paint("dim", text),
		"working… (Esc to interrupt)",
	);
	for (const component of [transcript, status, dialogs, editor, footer]) tui.addChild(component);
	tui.setFocus(editor);

	let busy = false;
	let interrupted = false;
	let finish: (code: number) => void = () => {};
	const done = new Promise<number>((resolve) => {
		finish = resolve;
	});
	/** Questions waiting for an answer, the first one on screen. */
	const questions: { dialog: Component; cancel: () => void }[] = [];

	const setBusy = (on: boolean) => {
		busy = on;
		editor.disableSubmit = on;
		status.clear();
		if (on) {
			status.addChild(loader);
			loader.start();
		} else loader.stop();
	};
	const showQuestion = () => {
		dialogs.clear();
		const first = questions[0];
		if (first) {
			dialogs.addChild(first.dialog);
			tui.setFocus(first.dialog);
		} else tui.setFocus(editor);
		tui.requestRender();
	};
	const ask = <T extends string>(
		question: { title: string; lines: string[]; choices: Choice<T>[]; initial: T; cancel: T; rows?: number },
		answer: (value: T) => void,
	) => {
		let answered = false;
		const entry = {
			dialog: new ChoiceDialog(question, paint, (value: T) => settle(value)),
			cancel: () => settle(question.cancel),
		};
		const settle = (value: T) => {
			if (answered) return;
			answered = true;
			questions.splice(questions.indexOf(entry), 1);
			answer(value);
			showQuestion();
		};
		questions.push(entry);
		if (questions.length === 1) showQuestion();
	};
	/** Drops the questions on screen: the core denied or dropped them when the turn ended. */
	const dropQuestions = () => {
		questions.splice(0);
		showQuestion();
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
			ask({ title, lines, choices, initial, cancel: CANCELLED, rows: LIST_ROWS }, (value) =>
				resolve(value === CANCELLED ? undefined : value),
			);
		});
	const listOptions = async () => (await request({ command: "options.list", cwd: args.cwd })) as Options | undefined;
	/** Sends a change of the session's configuration and shows in the footer what the core answered. */
	const configure = async (command: ClientCommand) => {
		const answer = (await request(command)) as SessionConfiguration | undefined;
		if (answer !== undefined) footer.state = footerWithConfiguration(footer.state, answer);
		return answer;
	};

	const onEvent = (id: string, event: AtelierEvent) => {
		if (id !== sessionId) return;
		footer.state = footerAfter(footer.state, event);
		conversation.event(event);
		// A subagent asks the same user through the same session: its questions are asked like the main agent's.
		if (event.type === "approval_requested")
			ask(
				{
					...approvalQuestion(event),
					choices: [
						{ value: "allow", label: "Allow" },
						{ value: "deny", label: "Deny" },
					],
					initial: "deny",
					cancel: "deny",
				},
				(value) =>
					void request({ command: "session.approve", sessionId, callId: event.callId, approved: value === "allow" }),
			);
		else if (event.type === "review_consent_requested")
			ask(
				{
					title: "Review this change?",
					lines: consentQuestion(event),
					choices: [
						{ value: "granted", label: "Review" },
						{ value: "declined", label: "Do not review" },
					],
					initial: "declined",
					cancel: "declined",
				},
				(answer) => void request({ command: "session.review_consent", sessionId, reviewId: event.reviewId, answer }),
			);
		else if (event.type === "turn_finished" && event.parentCallId === undefined) {
			dropQuestions();
			setBusy(false);
		}
		tui.requestRender();
	};

	let quitting = false;
	const quit = (code: number) => {
		if (quitting) return;
		quitting = true;
		finish(code);
	};
	const coreExited = (exit: CoreExit) => {
		if (quitting) return;
		options.stderr(
			`error: The core exited (${exit.signal ?? `exit code ${exit.code ?? "unknown"}`}).${exit.stderr ? `\n${exit.stderr}` : ""}\n`,
		);
		quit(EXIT_FAILED);
	};
	const startTurn = async (command: ClientCommand) => {
		interrupted = false;
		setBusy(true);
		const answer = await request(command);
		if (answer === undefined) setBusy(false);
	};
	const interrupt = () => {
		interrupted = true;
		conversation.note("interrupting… (Ctrl+C again to quit)");
		dropQuestions();
		void request({ command: "session.interrupt", sessionId });
	};

	/** Changes the mode, shown in the footer at once; a mode the core refused goes back, unless another came since. */
	const setMode = async (mode: PermissionMode) => {
		const before = footer.state.mode;
		footer.state = footerWithMode(footer.state, mode);
		tui.requestRender();
		if ((await request({ command: "session.set_mode", sessionId, mode })) !== undefined) return true;
		if (footer.state.mode === mode && before !== undefined) footer.state = footerWithMode(footer.state, before);
		return false;
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

	const runModel = async (name: string | undefined) => {
		const { backend, model: now } = footer.state;
		let model = name;
		if (model === undefined) {
			const options = await listOptions();
			if (options === undefined) return;
			const models = options.backends.find((listed) => listed.name === backend)?.models ?? [];
			if (models.length === 0)
				return conversation.note(
					`no models listed for ${shown(backend ?? "this backend").text}; use /model <name>`,
					true,
				);
			model = await pick(`Model on ${shown(backend ?? "").text}`, [], choicesOf(models, now), now);
			if (model === undefined) return;
		}
		if (model === now) return conversation.note(`model: ${shown(model).text} (unchanged)`);
		if ((await configure({ command: "session.set_model", sessionId, model })) === undefined) return;
		chosen = { ...chosen, model };
		conversation.note(`model: ${shown(model).text} from the next turn; the prompt cache starts over`);
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

	/** Moves the session to another backend once the user confirms that a summary replaces the conversation. */
	const runBackend = async (name: string | undefined) => {
		const now = footer.state.backend;
		let backend = name;
		if (backend === undefined) {
			const options = await listOptions();
			if (options === undefined) return;
			const names = options.backends.map((listed) => listed.name);
			backend = await pick("Backend", [], choicesOf(names, now), now);
			if (backend === undefined) return;
		}
		if (!isBackend(backend)) return conversation.note(`usage: /backend [${BACKEND_NAMES.join("|")}]`, true);
		if (backend === now) return conversation.note(`backend: ${backend} (unchanged)`);
		const answer = await pick(
			`Move this session to ${backend}?`,
			[
				"The new backend gets a summary of the conversation, not the conversation itself:",
				"detail is lost, and the prompt cache starts over.",
			],
			[
				{ value: "move", label: "Move, with a summary" },
				{ value: "stay", label: `Stay on ${shown(now ?? "this backend").text}` },
			],
			"stay",
		);
		if (answer !== "move") return conversation.note(`backend: ${shown(now ?? "unchanged").text} (unchanged)`);
		conversation.note(`moving to ${backend}: summarizing the conversation…`);
		tui.requestRender();
		const configuration = await configure({ command: "session.set_backend", sessionId, backend });
		if (configuration === undefined) return;
		// The model chosen was the old backend's; the new one starts with the profile's or its default.
		const { model: _model, ...rest } = chosen;
		chosen = { ...rest, backend };
		const carried = configuration.backendChange?.summarized
			? "with a summary of the conversation"
			: "nothing to carry yet";
		conversation.note(`backend: ${backend} from the next turn, ${carried}`);
	};

	/** Shows `next` in a conversation of its own and closes the session it replaces. */
	const switchTo = (next: Opened, shownIn: Conversation) => {
		const previous = sessionId;
		sessionId = next.sessionId;
		savedId = next.savedId;
		conversation = shownIn;
		footer.state = next.configuration === undefined ? {} : footerWithConfiguration({}, next.configuration);
		void request({ command: "session.close", sessionId: previous });
	};
	/** A conversation for the next session, after a rule that ends the one before. */
	const nextConversation = (title: string) => {
		const next = new Conversation(paint, args.cwd);
		next.addChild(new Text(paint("dim", `── ${title} ──`), 1, 1));
		transcript.addChild(next);
		return next;
	};
	const withoutConversation = (shownIn: Conversation) => transcript.removeChild(shownIn);

	/** Starts a new session with what was chosen and the mode in use; the one before stays on screen. */
	const runNew = async () => {
		const mode = isMode(footer.state.mode) ? footer.state.mode : undefined;
		const shownIn = nextConversation("new session");
		try {
			switchTo(await startSession(link, args, chosen, mode), shownIn);
		} catch (error) {
			withoutConversation(shownIn);
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

	const submit = async (line: string) => {
		const text = line.trim();
		if (text === "" || busy) return;
		editor.addToHistory(line);
		editor.setText("");
		if (text === "/exit") return quit(EXIT_OK);
		conversation.prompt(line);
		const words = text.split(/\s+/);
		const [command, argument] = words;
		const single = words.length <= 2;
		if (command === "/mode") await runMode(words);
		else if (command === "/model" && single) await runModel(argument);
		else if (command === "/effort" && single) await runEffort(argument);
		else if (command === "/profile" && single) await runProfile(argument);
		else if (command === "/backend" && single) await runBackend(argument);
		else if (text === "/new") await runNew();
		else if (command === "/resume" && single) await runResume(argument);
		else if (text === "/undo-correction") await startTurn({ command: "session.undo_correction", sessionId });
		else if (/^\/review(?:\s+\S+)?$/.test(text))
			await startTurn({ command: "session.review", sessionId, ...(words[1] === undefined ? {} : { ref: words[1] }) });
		else if (/^\/compact(?:\s|$)/.test(text)) {
			const instructions = text.slice("/compact".length).trim();
			await startTurn({ command: "session.compact", sessionId, ...(instructions === "" ? {} : { instructions }) });
		} else await startTurn({ command: "session.send", sessionId, prompt: line });
		tui.requestRender();
	};
	editor.onSubmit = (line) => void submit(line);

	// Ctrl+C interrupts a turn, then quits; with no turn it clears the editor, then quits. Esc interrupts a turn.
	const removeKeys = tui.addInputListener((data) => {
		if (matchesKey(data, "ctrl+c")) {
			if (busy && !interrupted) interrupt();
			else if (!busy && editor.getText() !== "") editor.setText("");
			else quit(EXIT_INTERRUPTED);
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
		if (matchesKey(data, "ctrl+d") && !busy && editor.getText() === "") {
			quit(EXIT_OK);
			return { consume: true };
		}
		// Shift+Tab takes the mode between normal and auto, as Claude Code's does; yolo is only chosen by name.
		if (matchesKey(data, "shift+tab") && questions.length === 0) {
			void setMode(nextMode(footer.state.mode));
			return { consume: true };
		}
		if (matchesKey(data, "ctrl+o")) {
			conversation.toggleCards();
			tui.requestRender(true);
			return { consume: true };
		}
		return undefined;
	});

	const removeEvents = link.onEvent(onEvent);
	const removeExit = link.onExit(coreExited);
	const removeTerminate = options.onTerminate?.((signal) => quit(SIGNAL_EXIT + signal));
	tui.start();
	try {
		return await done;
	} finally {
		removeKeys();
		removeEvents();
		removeExit();
		removeTerminate?.();
		loader.stop();
		tui.stop();
		// A core that does not answer must not keep the terminal's owner waiting: close the link anyway.
		let timer: NodeJS.Timeout | undefined;
		const gaveUp = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, options.closeTimeoutMs ?? CLOSE_TIMEOUT_MS);
		});
		await Promise.race([link.request({ command: "session.close", sessionId }).catch(() => {}), gaveUp]);
		clearTimeout(timer);
		await link.close();
	}
}
