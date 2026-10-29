import {
	BACKEND_DEFAULTS,
	BACKEND_MODELS,
	type BackendName,
	type ContextUsage,
	claudeCodeAliases,
	contextGauge,
	DEFAULT_BACKEND,
	type QueueKind,
	type ReviewConsentAnswer,
	type SessionProfile,
} from "@atelier/core/protocol";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import type { AtelierBridge } from "../../shared/bridge.ts";
import { FeaturePanel } from "./chat/FeaturePanel.tsx";
import { McpPanel, mcpChipLabel, mcpTroubled } from "./chat/McpPanel.tsx";
import { QueueList } from "./chat/QueueList.tsx";
import type { PermissionMode } from "./chat/reducer.ts";
import { Transcript, UNSANDBOXED_EFFECT } from "./chat/Transcript.tsx";
import { useChat } from "./chat/use-chat.ts";

const MODES: readonly PermissionMode[] = ["normal", "auto", "yolo"];
const MODE_HINTS: Partial<Record<PermissionMode, string>> = {
	auto: "auto: a classifier model decides what normal would ask",
};

const MODELS = BACKEND_MODELS;
const CLAUDE_CODE_ALIASES = claudeCodeAliases(MODELS["claude-code"]);
const BACKENDS = Object.keys(MODELS) as BackendName[];

const numbers = new Intl.NumberFormat("en-US");

/** The core's reason for a session started with `noSandbox`. */
const SANDBOX_TURNED_OFF = "sandbox turned off for this session";

/** The status bar's styles for a context near where it compacts. */
const LEVEL_CLASSES = { normal: undefined, warning: "warning", danger: "error" } as const;

/** How full the context is; right after a compaction the size is not known until a request measures it. */
function ContextLabel({ context }: { context: ContextUsage }) {
	const { text, level } = contextGauge(context);
	const compacts = `compacts at ${numbers.format(context.compactAt)} tokens`;
	const title = context.unknown
		? compacts
		: `${numbers.format(context.tokens)} of ${numbers.format(context.window)} tokens · ${compacts}`;
	return (
		<span className={LEVEL_CLASSES[level]} title={title}>
			ctx {text}
		</span>
	);
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
	const [model, setModel] = useState(BACKEND_DEFAULTS[DEFAULT_BACKEND]);
	const [noSandbox, setNoSandbox] = useState(false);
	// An alias (claude-code's default, `opus`) shows as the model it stands for; the alias is what is sent.
	const shownModel = (backend === "claude-code" ? CLAUDE_CODE_ALIASES[model] : undefined) ?? model;
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
	const [mcpOpen, setMcpOpen] = useState(false);
	const onAnswer = useCallback(
		(callId: string, approved: boolean, remember?: "session" | "always") =>
			void chat.answerApproval(callId, approved, remember),
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
	/** Enter sends, or queues a steer while a turn runs; Alt+Enter queues a follow-up then. */
	const submit = (event?: FormEvent, kind: QueueKind = "steer") => {
		event?.preventDefault();
		const prompt = draft.trim();
		if (!prompt || !state.session) return;
		setDraft("");
		if (state.busy)
			// Not taken, it goes back before whatever was typed meanwhile.
			void chat.queue(prompt, kind).then((queued) => {
				if (!queued) setDraft((typed) => [prompt, typed].filter((text) => text.trim() !== "").join("\n\n"));
			});
		else void chat.send(prompt);
	};
	// What an interrupted or failed turn gave back goes before what is being typed.
	const returned = state.returned;
	useEffect(() => {
		if (returned === undefined) return;
		setDraft((typed) => [...returned.texts, typed].filter((text) => text.trim() !== "").join("\n\n"));
	}, [returned]);
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
							setModel(BACKEND_DEFAULTS[next]);
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
					<select value={shownModel} onChange={(event) => setModel(event.target.value)} disabled={state.busy}>
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
				{mcpOpen && state.mcp ? <McpPanel mcp={state.mcp} onLogin={(server) => void chat.loginMcp(server)} /> : null}
			</div>

			{state.queue ? (
				<QueueList
					queue={state.queue}
					onEdit={(id, text) => void chat.editQueued(id, text)}
					onRemove={(id) => void chat.unqueue(id)}
				/>
			) : null}
			<form className="composer" onSubmit={submit}>
				<textarea
					aria-label="Prompt"
					value={draft}
					placeholder={
						!state.session
							? "Open a folder to start"
							: state.busy
								? "Steer the turn… (Enter: with the next tool result, Alt+Enter: after the turn)"
								: "Ask for a change… (Enter to send, Shift+Enter for a new line)"
					}
					disabled={!state.session}
					onChange={(event) => setDraft(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey) {
							event.preventDefault();
							submit(undefined, event.altKey ? "follow_up" : "steer");
						}
					}}
				/>
				<button type="submit" disabled={!state.session || draft.trim() === ""}>
					{state.busy ? "Queue" : "Send"}
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
				{state.context ? <ContextLabel context={state.context} /> : null}
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
				{state.mcp ? (
					<button
						type="button"
						className={mcpTroubled(state.mcp) ? "mcp-chip warning" : "mcp-chip"}
						title="MCP servers: connected / enabled"
						onClick={() => {
							if (!mcpOpen) void chat.refreshMcp();
							setMcpOpen(!mcpOpen);
						}}
					>
						{mcpChipLabel(state.mcp.servers)}
					</button>
				) : null}
				{state.instructions && state.instructions.files.length > 0 ? (
					<span title={state.instructions.files.join("\n")}>instructions: {state.instructions.files.length}</span>
				) : null}
				{state.instructions && state.instructions.dropped.length > 0 ? (
					<span className="warning" title={state.instructions.dropped.join("\n")}>
						instructions over 32 KiB: {state.instructions.dropped.length} left out
					</span>
				) : null}
				{state.skills && state.skills.skills.length > 0 ? (
					<span title={state.skills.skills.map(({ name, path }) => `${name}  ${path}`).join("\n")}>
						skills: {state.skills.skills.length}
					</span>
				) : null}
				{state.skills && state.skills.warnings.length > 0 ? (
					<span
						className="warning"
						title={state.skills.warnings.map(({ path, message }) => `${path}: ${message}`).join("\n")}
					>
						skills: {state.skills.warnings.length} {state.skills.warnings.length === 1 ? "warning" : "warnings"}
					</span>
				) : null}
				{state.review ? (
					<span className="warning" title={state.review.reason}>
						no review{state.review.reason ? `: ${state.review.reason}` : ""}
					</span>
				) : null}
				{state.backend === "anthropic-api" ? (
					<span>billed to your Anthropic API key</span>
				) : state.backend === "opencode-go" ? (
					<span>billed to your OpenCode Go plan</span>
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
