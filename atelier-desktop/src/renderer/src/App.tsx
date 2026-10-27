import {
	BACKEND_MODELS,
	type BackendName,
	DEFAULT_BACKEND,
	type ReviewConsentAnswer,
	type SessionProfile,
} from "@atelier/core/protocol";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { AtelierBridge } from "../../shared/bridge.ts";
import { FeaturePanel } from "./chat/FeaturePanel.tsx";
import type { PermissionMode } from "./chat/reducer.ts";
import { Transcript, UNSANDBOXED_EFFECT } from "./chat/Transcript.tsx";
import { useChat } from "./chat/use-chat.ts";

const MODES: readonly PermissionMode[] = ["normal", "auto", "yolo"];
const MODE_HINTS: Partial<Record<PermissionMode, string>> = {
	auto: "auto: a classifier model decides what normal would ask",
};

/** The first model of each backend is its default. */
const MODELS = BACKEND_MODELS;
const BACKENDS = Object.keys(MODELS) as BackendName[];

const numbers = new Intl.NumberFormat("en-US");

/** The core's reason for a session started with `noSandbox`. */
const SANDBOX_TURNED_OFF = "sandbox turned off for this session";

function contextLabel({ tokens, window }: { tokens: number; window: number }): string {
	return `context ${numbers.format(tokens)} / ${numbers.format(window)} (${Math.round((tokens / window) * 100)}%)`;
}

/** `profile: cheap (repo)`, or `profile: default`. */
function profileLabel({ name, origin }: SessionProfile): string {
	return name === undefined ? `profile: ${origin}` : `profile: ${name} (${origin})`;
}

/** One line per role the profile sets: `verifier: anthropic-api/claude-sonnet-5-5 thinking medium`. */
function profileRoles({ roles }: SessionProfile): string {
	return Object.entries(roles)
		.map(([role, { backend, model, thinking }]) => {
			const parts: string[] = [];
			if (model !== undefined) parts.push(backend === undefined ? model : `${backend}/${model}`);
			if (thinking !== undefined) parts.push(`thinking ${thinking}`);
			return `${role}: ${parts.join(" ")}`;
		})
		.join("\n");
}

function coreLabel(core: ReturnType<typeof useChat>["state"]["core"]): string {
	if (core.status === "ready") return `core ${core.version}`;
	if (core.status === "starting") return "starting the core…";
	return core.status === "failed" ? "core failed to start" : "core stopped";
}

export function App({ bridge = window.atelier }: { bridge?: AtelierBridge }) {
	const chat = useChat(bridge);
	const { state } = chat;
	const [backend, setBackend] = useState<BackendName>(DEFAULT_BACKEND);
	const [model, setModel] = useState(MODELS[DEFAULT_BACKEND][0] as string);
	const [noSandbox, setNoSandbox] = useState(false);
	/** Empty: the core resolves the profile by layers. */
	const [chosen, setProfile] = useState("");
	// What the selector shows is what is sent: a name the listed profiles lack counts as "by layers".
	const profile = chat.profiles.profiles.includes(chosen) ? chosen : "";
	useEffect(() => {
		if (chosen !== profile) setProfile("");
	}, [chosen, profile]);
	/** Empty: no `mode` is sent, so the core uses the default it has saved. */
	const [mode, setMode] = useState<PermissionMode | "">("");
	const [draft, setDraft] = useState("");
	const onAnswer = useCallback(
		(callId: string, approved: boolean) => void chat.answerApproval(callId, approved),
		[chat],
	);

	const onConsent = useCallback(
		(reviewId: string, answer: ReviewConsentAnswer) => void chat.answerReviewConsent(reviewId, answer),
		[chat],
	);

	const onUndo = useCallback((reviewId: string) => void chat.undoCorrection(reviewId), [chat]);

	const openFolder = async () => {
		const cwd = await chat.pickFolder();
		if (cwd) await chat.openSession(cwd, model, backend, noSandbox, profile || undefined, mode || undefined);
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
					backend{" "}
					<select
						value={backend}
						onChange={(event) => {
							const next = event.target.value as BackendName;
							setBackend(next);
							setModel(MODELS[next][0] as string);
						}}
						disabled={state.busy}
					>
						{BACKENDS.map((name) => (
							<option key={name}>{name}</option>
						))}
					</select>
				</label>
				<label>
					model{" "}
					<select value={model} onChange={(event) => setModel(event.target.value)} disabled={state.busy}>
						{MODELS[backend].map((name) => (
							<option key={name}>{name}</option>
						))}
					</select>
				</label>
				{chat.profiles.profiles.length > 0 ? (
					<label>
						profile{" "}
						<select value={profile} onChange={(event) => setProfile(event.target.value)} disabled={state.busy}>
							<option value="">
								{chat.profiles.active === undefined ? "by layers" : `by layers (active: ${chat.profiles.active})`}
							</option>
							{chat.profiles.profiles.map((name) => (
								<option key={name}>{name}</option>
							))}
						</select>
					</label>
				) : null}
				<label>
					mode{" "}
					<select
						value={mode}
						onChange={(event) => setMode(event.target.value as PermissionMode | "")}
						disabled={state.busy}
					>
						<option value="">default</option>
						{MODES.map((name) => (
							<option key={name} title={MODE_HINTS[name]}>
								{name}
							</option>
						))}
					</select>
				</label>
				<label className={noSandbox ? "warning" : undefined}>
					<input
						type="checkbox"
						checked={noSandbox}
						onChange={(event) => setNoSandbox(event.target.checked)}
						disabled={state.busy}
					/>{" "}
					run bash without the sandbox
				</label>
				<button type="button" onClick={() => void chat.review()} disabled={!state.session || state.busy}>
					Review
				</button>
				<button type="button" onClick={() => void chat.interrupt()} disabled={!state.busy}>
					Interrupt
				</button>
				{coreDown ? (
					<button type="button" onClick={() => void chat.restartCore()}>
						Restart core
					</button>
				) : null}
			</header>

			<div className="workspace">
				<main>
					<Transcript turns={state.turns} onAnswer={onAnswer} onConsent={onConsent} onUndo={onUndo} />
				</main>
				{state.feature ? <FeaturePanel feature={state.feature} /> : null}
			</div>

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
				{state.model ? (
					<span>{state.effort === undefined ? state.model : `${state.model} · effort ${state.effort}`}</span>
				) : null}
				{state.profile ? <span title={profileRoles(state.profile)}>{profileLabel(state.profile)}</span> : null}
				{state.session && state.permissionMode ? (
					<select
						aria-label="session mode"
						className={state.permissionMode === "yolo" ? "warning" : undefined}
						value={state.permissionMode}
						onChange={(event) => void chat.setMode(event.target.value as PermissionMode)}
					>
						{MODES.map((name) => (
							<option key={name} title={MODE_HINTS[name]}>
								{name}
							</option>
						))}
					</select>
				) : null}
				{state.phase ? <span className="phase">{state.phase}</span> : null}
				{state.context ? (
					<span title={`compacts at ${numbers.format(state.context.compactAt)} tokens`}>
						{contextLabel(state.context)}
					</span>
				) : null}
				{state.session?.noSandbox ? (
					<span className="warning" title={`${SANDBOX_TURNED_OFF}: ${UNSANDBOXED_EFFECT}`}>
						bash: NOT SANDBOXED (turned off)
					</span>
				) : state.sandbox ? (
					state.sandbox.sandboxed ? (
						<span>bash: sandboxed ({state.sandbox.mechanism ?? "sandbox"})</span>
					) : (
						<span className="warning" title={`${state.sandbox.reason ?? "unavailable"}: ${UNSANDBOXED_EFFECT}`}>
							bash: not sandboxed
						</span>
					)
				) : null}
				{state.memory ? (
					state.memory.available ? (
						<span>memory: {state.memory.project}</span>
					) : (
						<span className="warning" title={state.memory.reason}>
							no memory
						</span>
					)
				) : null}
				{state.instructions && state.instructions.files.length > 0 ? (
					<span title={state.instructions.files.join("\n")}>instructions: {state.instructions.files.length}</span>
				) : null}
				{state.instructions && state.instructions.dropped.length > 0 ? (
					<span className="warning" title={state.instructions.dropped.join("\n")}>
						instructions over 32 KiB: {state.instructions.dropped.length} left out
					</span>
				) : null}
				{state.review ? (
					<span className="warning" title={state.review.reason}>
						no review{state.review.reason ? `: ${state.review.reason}` : ""}
					</span>
				) : null}
				{state.backend === "anthropic-api" ? (
					<span>billed to your Anthropic API key</span>
				) : state.authSource && state.authSource !== "subscription" ? (
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
