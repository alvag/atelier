import { type FormEvent, useCallback, useState } from "react";
import type { AtelierBridge } from "../../shared/bridge.ts";
import { Transcript } from "./chat/Transcript.tsx";
import { useChat } from "./chat/use-chat.ts";

const MODELS = ["opus", "sonnet", "haiku"];

function coreLabel(core: ReturnType<typeof useChat>["state"]["core"]): string {
	if (core.status === "ready") return `core ${core.version}`;
	if (core.status === "starting") return "starting the core…";
	return core.status === "failed" ? "core failed to start" : "core stopped";
}

export function App({ bridge = window.atelier }: { bridge?: AtelierBridge }) {
	const chat = useChat(bridge);
	const { state } = chat;
	const [model, setModel] = useState(MODELS[0] as string);
	const [draft, setDraft] = useState("");
	const onAnswer = useCallback(
		(callId: string, approved: boolean) => void chat.answerApproval(callId, approved),
		[chat],
	);

	const openFolder = async () => {
		const cwd = await chat.pickFolder();
		if (cwd) await chat.openSession(cwd, model);
	};
	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		const prompt = draft.trim();
		if (!prompt || state.busy || !state.session) return;
		setDraft("");
		void chat.send(prompt);
	};
	const coreDown = state.core.status === "failed" || state.core.status === "exited";

	return (
		<div className="app">
			<header className="toolbar">
				<button type="button" onClick={() => void openFolder()} disabled={state.core.status !== "ready" || state.busy}>
					{state.session ? "New session…" : "Open folder…"}
				</button>
				<span className="cwd">{state.session?.cwd ?? "no folder"}</span>
				<label>
					model{" "}
					<select value={model} onChange={(event) => setModel(event.target.value)} disabled={state.busy}>
						{MODELS.map((name) => (
							<option key={name}>{name}</option>
						))}
					</select>
				</label>
				<button type="button" onClick={() => void chat.interrupt()} disabled={!state.busy}>
					Interrupt
				</button>
				{coreDown ? (
					<button type="button" onClick={() => void chat.restartCore()}>
						Restart core
					</button>
				) : null}
			</header>

			<main>
				<Transcript turns={state.turns} onAnswer={onAnswer} />
			</main>

			<form className="composer" onSubmit={submit}>
				<textarea
					aria-label="Prompt"
					value={draft}
					placeholder={
						state.session ? "Ask for a change… (Enter to send, Shift+Enter for a new line)" : "Open a folder to start"
					}
					disabled={!state.session}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit();
						}
					}}
				/>
				<button type="submit" disabled={!state.session || state.busy || draft.trim() === ""}>
					Send
				</button>
			</form>

			<footer className="status" role="status">
				<span>{coreLabel(state.core)}</span>
				{state.model ? <span>{state.model}</span> : null}
				{state.authSource && state.authSource !== "subscription" ? (
					<span className="warning">not using a Claude subscription ({state.authSource})</span>
				) : null}
				{state.notice ? <span className="warning">{state.notice}</span> : null}
				{state.lastError ? (
					<span className="error">
						{state.lastError.code}: {state.lastError.message}
					</span>
				) : null}
			</footer>
		</div>
	);
}
