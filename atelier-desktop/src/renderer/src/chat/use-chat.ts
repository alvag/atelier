import type {
	BackendName,
	ClientCommand,
	McpServerStatus,
	QueueKind,
	ReviewConsentAnswer,
} from "@atelier/core/protocol";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { AtelierBridge, CommandResult, HostMessage } from "../../../shared/bridge.ts";
import { type ChatAction, type ChatState, initialChatState, type PermissionMode, reduceChat } from "./reducer.ts";

const nextFrame = (callback: () => void) =>
	typeof requestAnimationFrame === "function" ? requestAnimationFrame(callback) : setTimeout(callback, 16);

export interface Chat {
	state: ChatState;
	/**
	 * With `noSandbox`, the session's `bash` runs without the sandbox; `profile` is the chosen profile, absent to resolve it by layers;
	 * `mode` is the chosen permission mode, absent to use the default the core has saved.
	 */
	openSession(
		cwd: string,
		model: string | undefined,
		backend: BackendName,
		noSandbox?: boolean,
		profile?: string,
		mode?: PermissionMode,
	): Promise<void>;
	/** Changes the open session's mode; the state shows the mode the core answers, and keeps the previous one if it fails. */
	setMode(mode: PermissionMode): Promise<void>;
	/** The profile names in `~/.atelier/profiles.json` and its `active`, asked each time the core is ready; none when it cannot say. */
	profiles: ProfileList;
	send(prompt: string): Promise<void>;
	/**
	 * Queues a message while a turn runs: a steer for the running turn, a follow-up for a turn of its own after it.
	 * Answers whether the core took it; when it did not, the text is the caller's again.
	 */
	queue(text: string, kind: QueueKind): Promise<boolean>;
	/** Changes a queued message's text; nothing happens when it already entered the conversation. */
	editQueued(messageId: string, text: string): Promise<void>;
	/** Takes a queued message off the queue. */
	unqueue(messageId: string): Promise<void>;
	interrupt(): Promise<void>;
	answerApproval(callId: string, approved: boolean, remember?: "session" | "always"): Promise<void>;
	answerReviewConsent(reviewId: string, answer: ReviewConsentAnswer): Promise<void>;
	/** Reviews the session's current uncommitted change, at any risk. */
	review(): Promise<void>;
	/** Undoes the correction the escalated review `reviewId` left in the worktree. */
	undoCorrection(reviewId: string): Promise<void>;
	/** Asks the core for the session's MCP servers as they are now. */
	refreshMcp(): Promise<void>;
	/** Signs an MCP server in with OAuth: the core opens the browser and waits for it. */
	loginMcp(server: string): Promise<void>;
	restartCore(): Promise<void>;
	pickFolder(): Promise<string | undefined>;
}

export interface ProfileList {
	profiles: string[];
	active?: string;
}

const NO_PROFILES: ProfileList = { profiles: [] };

/** What `profiles.list` answered, keeping only names. */
function profileList(result: Record<string, unknown>): ProfileList {
	const { profiles, active } = result;
	return {
		profiles: Array.isArray(profiles) ? profiles.filter((name): name is string => typeof name === "string") : [],
		...(typeof active === "string" ? { active } : {}),
	};
}

/** Chat state fed by the bridge. Host messages are applied once per frame, so streaming does not re-render per delta. */
export function useChat(bridge: AtelierBridge): Chat {
	const [state, dispatch] = useReducer(reduceChat, initialChatState);
	const stateRef = useRef(state);
	stateRef.current = state;

	useEffect(() => {
		let queue: ChatAction[] = [];
		let scheduled = false;
		const flush = () => {
			scheduled = false;
			const actions = queue;
			queue = [];
			if (actions.length > 0) dispatch({ type: "batch", actions });
		};
		const unsubscribe = bridge.onMessage((message: HostMessage) => {
			queue.push(message);
			if (!scheduled) {
				scheduled = true;
				nextFrame(flush);
			}
		});
		// The core status may have been sent before this subscription existed.
		void bridge.getStatus().then((status) => {
			if (status) dispatch(status);
		});
		return unsubscribe;
	}, [bridge]);

	const [profiles, setProfiles] = useState<ProfileList>(NO_PROFILES);
	const ready = state.core.status === "ready";
	useEffect(() => {
		if (!ready) return;
		let current = true;
		void bridge.request({ command: "profiles.list" }).then((result) => {
			if (current) setProfiles(result.ok ? profileList(result.result) : NO_PROFILES);
		});
		return () => {
			current = false;
		};
	}, [bridge, ready]);

	const request = useCallback(
		async (command: ClientCommand): Promise<CommandResult> => {
			const result = await bridge.request(command);
			if (!result.ok) dispatch({ type: "command_failed", ...result.error });
			return result;
		},
		[bridge],
	);

	/**
	 * A command on the queue: its failure is shown but leaves the turn running, and a message that entered the
	 * conversation before the command arrived (`not_queued`) is no failure.
	 */
	const queueCommand = async (command: ClientCommand): Promise<boolean> => {
		const result = await bridge.request(command);
		if (!result.ok && result.error.code !== "not_queued") dispatch({ type: "queue_failed", ...result.error });
		return result.ok;
	};

	/** `session.mcp`, or `session.mcp_login` for `server`; the answer is the servers as they are now. */
	const mcpCommand = async (server: string | undefined) => {
		const session = stateRef.current.session;
		if (!session) return;
		const result = await request(
			server === undefined
				? { command: "session.mcp", sessionId: session.id }
				: { command: "session.mcp_login", sessionId: session.id, server },
		);
		if (!result.ok) return;
		const { servers, problems } = result.result;
		if (Array.isArray(servers) && Array.isArray(problems))
			dispatch({
				type: "mcp_answered",
				servers: servers as unknown as McpServerStatus[],
				problems: problems.filter((problem): problem is string => typeof problem === "string"),
			});
	};

	return {
		state,
		profiles,
		openSession: async (cwd, model, backend, noSandbox = false, profile, mode) => {
			const previous = stateRef.current.session;
			if (previous) await request({ command: "session.close", sessionId: previous.id });
			const result = await request({
				command: "session.start",
				cwd,
				...(model ? { model } : {}),
				backend,
				...(noSandbox ? { noSandbox: true } : {}),
				...(profile ? { profile } : {}),
				...(mode ? { mode } : {}),
			});
			if (result.ok && typeof result.result.sessionId === "string")
				dispatch({ type: "session_opened", sessionId: result.result.sessionId, cwd, noSandbox });
		},
		setMode: async (mode) => {
			const session = stateRef.current.session;
			if (!session) return;
			const result = await request({ command: "session.set_mode", sessionId: session.id, mode });
			const answered = result.ok ? result.result.mode : undefined;
			if (answered === "normal" || answered === "auto" || answered === "yolo")
				dispatch({ type: "mode_changed", mode: answered });
		},
		send: async (prompt) => {
			const session = stateRef.current.session;
			if (!session) return;
			const compact = /^\/compact(?:\s+([\s\S]*))?$/.exec(prompt.trim());
			if (compact) {
				const instructions = compact[1]?.trim();
				dispatch({ type: "prompt_sent", text: prompt.trim() });
				const result = await request({
					command: "session.compact",
					sessionId: session.id,
					...(instructions ? { instructions } : {}),
				});
				if (result.ok && typeof result.result.turnId === "string")
					dispatch({ type: "turn_accepted", turnId: result.result.turnId });
				return;
			}
			dispatch({ type: "prompt_sent", text: prompt });
			const result = await request({ command: "session.send", sessionId: session.id, prompt });
			if (result.ok && typeof result.result.turnId === "string")
				dispatch({ type: "turn_accepted", turnId: result.result.turnId });
		},
		queue: async (text, kind) => {
			const session = stateRef.current.session;
			if (!session) return false;
			return queueCommand({ command: "session.queue", sessionId: session.id, kind, text });
		},
		editQueued: async (messageId, text) => {
			const session = stateRef.current.session;
			if (session) await queueCommand({ command: "session.queue_edit", sessionId: session.id, messageId, text });
		},
		unqueue: async (messageId) => {
			const session = stateRef.current.session;
			if (session) await queueCommand({ command: "session.unqueue", sessionId: session.id, messageId });
		},
		interrupt: async () => {
			const session = stateRef.current.session;
			if (session) await request({ command: "session.interrupt", sessionId: session.id });
		},
		answerApproval: async (callId, approved, remember) => {
			const session = stateRef.current.session;
			if (!session) return;
			const remembering = approved && remember !== undefined ? { remember } : {};
			dispatch({ type: "approval_answered", callId, approved, ...remembering });
			await request({ command: "session.approve", sessionId: session.id, callId, approved, ...remembering });
		},
		answerReviewConsent: async (reviewId, answer) => {
			const session = stateRef.current.session;
			if (!session) return;
			dispatch({ type: "review_consent_answered", reviewId, answer });
			await request({ command: "session.review_consent", sessionId: session.id, reviewId, answer });
		},
		review: async () => {
			const session = stateRef.current.session;
			if (!session) return;
			dispatch({ type: "prompt_sent", text: "/review" });
			const result = await request({ command: "session.review", sessionId: session.id });
			if (result.ok && typeof result.result.turnId === "string")
				dispatch({ type: "turn_accepted", turnId: result.result.turnId });
		},
		undoCorrection: async (reviewId) => {
			const session = stateRef.current.session;
			if (!session) return;
			dispatch({ type: "prompt_sent", text: "/undo-correction" });
			const result = await request({ command: "session.undo_correction", sessionId: session.id, reviewId });
			if (result.ok && typeof result.result.turnId === "string")
				dispatch({ type: "turn_accepted", turnId: result.result.turnId });
		},
		refreshMcp: () => mcpCommand(undefined),
		loginMcp: (server) => mcpCommand(server),
		restartCore: () => bridge.restartCore(),
		pickFolder: () => bridge.pickFolder(),
	};
}
