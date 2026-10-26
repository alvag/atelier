import {
	type AtelierEvent,
	type ClientCommand,
	describeError,
	type JsonValue,
	type PermissionMode,
	type SavedEntry,
	visibleText,
	writeDefaultPermissionMode,
} from "@atelier/core";
import type { CoreExit } from "@atelier/core/client";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Editor,
	Loader,
	matchesKey,
	type Terminal,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import type { CliArgs } from "../args.ts";
import { savedTranscript } from "../transcript.ts";
import { Conversation } from "./conversation.ts";
import { ChoiceDialog } from "./dialog.ts";
import { type FooterState, footerAfter, footerLine, footerWithMode } from "./footer.ts";
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
}

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_INTERRUPTED = 130;
const SIGNAL_EXIT = 128;

const COMMANDS = [
	{ name: "mode", description: "Show or change the permission mode: [normal|auto|yolo] | default <mode>" },
	{ name: "review", description: "Review the current changes, against HEAD or a git ref" },
	{ name: "undo-correction", description: "Undo the latest escalated review's correction" },
	{ name: "compact", description: "Summarize the older history now [instructions]" },
	{ name: "exit", description: "Close the session" },
];

const shown = (text: string) => visibleText(text);
const isMode = (word: string | undefined): word is PermissionMode =>
	word === "normal" || word === "auto" || word === "yolo";

/** ` (asked by worker)` for a subagent's question; the main agent's says nothing. */
const asker = (event: AtelierEvent) =>
	event.parentCallId === undefined ? "" : ` (asked by ${event.agent ?? "a subagent"})`;

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
	const guard = event.confirm === undefined ? "" : ` (guard: ${event.confirm})`;
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
		`risk: ${event.level}`,
		`reasons: ${event.reasons.map((reason) => shown(reason).text).join("; ")}`,
		`lenses: ${event.lenses.join(", ")}${why}`,
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

/** Starts or resumes the session the arguments ask for; answers its id, or the message to fail with. */
async function openSession(
	link: CoreLink,
	args: CliArgs,
	conversation: Conversation,
): Promise<{ sessionId: string } | { error: string }> {
	const mode = args.mode ?? (args.yes ? "normal" : undefined);
	if (!args.continueSession && args.resume === undefined) {
		const started = (await link.request({
			command: "session.start",
			cwd: args.cwd,
			...(args.model === undefined ? {} : { model: args.model }),
			...(args.explicitBackend === undefined ? {} : { backend: args.explicitBackend }),
			...(mode === undefined ? {} : { mode }),
			...(args.profile === undefined ? {} : { profile: args.profile }),
			...(args.noSession ? { noSession: true } : {}),
		})) as { sessionId: string };
		return { sessionId: started.sessionId };
	}
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
	const resumed = (await link.request({ command: "session.resume", sessionId: saved.id, cwd: args.cwd })) as {
		sessionId: string;
		name?: string;
		entries: JsonValue[];
	};
	const { sessionId } = resumed;
	conversation.plain(savedTranscript(saved.id, resumed.name, resumed.entries as unknown as SavedEntry[]));
	// What the arguments ask for wins over what was saved, as at start.
	if (mode !== undefined) await link.request({ command: "session.set_mode", sessionId, mode });
	if (args.profile !== undefined)
		await link.request({ command: "session.set_profile", sessionId, profile: args.profile });
	if (args.model !== undefined) await link.request({ command: "session.set_model", sessionId, model: args.model });
	return { sessionId };
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
	const conversation = new Conversation(paint, options.color, args.cwd);
	let opened: { sessionId: string } | { error: string };
	try {
		opened = await openSession(link, args, conversation);
	} catch (error) {
		opened = { error: describeError(error) };
	}
	if ("error" in opened) {
		await link.close();
		options.stderr(`error: ${opened.error}\n`);
		return EXIT_FAILED;
	}
	const { sessionId } = opened;

	const tui = new TuiMainScreen(options.terminal);
	const footer = new Footer(paint);
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
	for (const component of [conversation, status, dialogs, editor, footer]) tui.addChild(component);
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
		question: { title: string; lines: string[]; choices: { value: T; label: string }[]; initial: T; cancel: T },
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

	const runMode = async (words: string[]) => {
		const [, first, second] = words;
		if (first === undefined) return conversation.note(`mode: ${footer.state.mode ?? "unknown until the first turn"}`);
		if (words.length === 2 && isMode(first)) {
			if ((await request({ command: "session.set_mode", sessionId, mode: first })) === undefined) return;
			footer.state = footerWithMode(footer.state, first);
			return conversation.note(`mode: ${first} (this session)`);
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

	const submit = async (line: string) => {
		const text = line.trim();
		if (text === "" || busy) return;
		editor.addToHistory(line);
		editor.setText("");
		if (text === "/exit") return quit(EXIT_OK);
		conversation.prompt(line);
		const words = text.split(/\s+/);
		if (words[0] === "/mode") await runMode(words);
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
		await link.request({ command: "session.close", sessionId }).catch(() => {});
		await link.close();
	}
}
