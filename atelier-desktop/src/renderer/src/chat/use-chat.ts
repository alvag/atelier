import type { BackendName, ClientCommand } from "@atelier/core/protocol";
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AtelierBridge, CommandResult, HostMessage } from "../../../shared/bridge.ts";
import { type ChatAction, type ChatState, initialChatState, reduceChat } from "./reducer.ts";

const nextFrame = (callback: () => void) =>
	typeof requestAnimationFrame === "function" ? requestAnimationFrame(callback) : setTimeout(callback, 16);

export interface Chat {
	state: ChatState;
	/** With `noSandbox`, the session's `bash` runs without the sandbox. */
	openSession(cwd: string, model: string | undefined, backend: BackendName, noSandbox?: boolean): Promise<void>;
	send(prompt: string): Promise<void>;
	interrupt(): Promise<void>;
	answerApproval(callId: string, approved: boolean): Promise<void>;
	answerReviewConsent(reviewId: string, answer: "granted" | "declined"): Promise<void>;
	/** Reviews the session's current uncommitted change, at any risk. */
	review(): Promise<void>;
	restartCore(): Promise<void>;
	pickFolder(): Promise<string | undefined>;
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

	const request = useCallback(
		async (command: ClientCommand): Promise<CommandResult> => {
			const result = await bridge.request(command);
			if (!result.ok) dispatch({ type: "command_failed", ...result.error });
			return result;
		},
		[bridge],
	);

	return {
		state,
		openSession: async (cwd, model, backend, noSandbox = false) => {
			const previous = stateRef.current.session;
			if (previous) await request({ command: "session.close", sessionId: previous.id });
			const result = await request({
				command: "session.start",
				cwd,
				...(model ? { model } : {}),
				backend,
				...(noSandbox ? { noSandbox: true } : {}),
			});
			if (result.ok && typeof result.result.sessionId === "string")
				dispatch({ type: "session_opened", sessionId: result.result.sessionId, cwd, noSandbox });
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
		interrupt: async () => {
			const session = stateRef.current.session;
			if (session) await request({ command: "session.interrupt", sessionId: session.id });
		},
		answerApproval: async (callId, approved) => {
			const session = stateRef.current.session;
			if (!session) return;
			dispatch({ type: "approval_answered", callId, approved });
			await request({ command: "session.approve", sessionId: session.id, callId, approved });
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
		restartCore: () => bridge.restartCore(),
		pickFolder: () => bridge.pickFolder(),
	};
}
