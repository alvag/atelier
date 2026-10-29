import { isAbsolute, relative } from "node:path";
import { styleText } from "node:util";
import {
	type AtelierEvent,
	cacheHitRate,
	describeRefusal,
	type JsonValue,
	type PhaseAgent,
	type PhaseSpent,
	type ReviewStep,
	type TurnPhase,
	visibleText,
} from "@atelier/core";
import { MEMORY_TOOL, memoryCallText, memoryOutcome, SUMMARY_WARNING, summaryCall } from "./memory-call.ts";

export interface RendererOptions {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	color: boolean;
	/** Receipt paths under it are shown relative to it. */
	cwd?: string;
}

type Style = Parameters<typeof styleText>[0];

const numbers = new Intl.NumberFormat("en-US");

/** The backends billed to an API key by choice: no warning that they do not use a Claude subscription. */
export const API_KEY_BACKENDS: ReadonlySet<string> = new Set(["anthropic-api", "opencode-go"]);
/** Starts every line a subagent produces, so its work reads as nested under the task call. */
const CHILD = "  │ ";

function tokensLine(event: Extract<AtelierEvent, { type: "turn_finished" }>): string {
	const { input, output, cacheRead, cacheWrite } = event.usage;
	const parts = [
		`input ${numbers.format(input)}`,
		`output ${numbers.format(output)}`,
		`cache read ${numbers.format(cacheRead)}`,
		`cache write ${numbers.format(cacheWrite)}`,
	];
	const rate = cacheHitRate(event.usage);
	if (rate !== undefined) parts.push(`cache ${Math.round(rate * 100)}%`);
	if (event.requests !== undefined) parts.push(`${event.requests} request${event.requests === 1 ? "" : "s"}`);
	if (event.costUsd !== undefined) parts.push(`$${event.costUsd.toFixed(4)}`);
	if (event.context !== undefined) {
		const { tokens, window } = event.context;
		parts.push(
			`context ${numbers.format(tokens)} / ${numbers.format(window)} (${Math.round((tokens / window) * 100)}%)`,
		);
	}
	return `tokens: ${parts.join(" · ")}`;
}

function compactingLine(event: Extract<AtelierEvent, { type: "compaction_started" }>): string {
	return `◇ compacting context (${event.reason}, ${numbers.format(event.tokens)} tokens)`;
}

/** How much the context went down, what was kept and the cost, as far as the backend reports them. */
function compactedLine(event: Extract<AtelierEvent, { type: "compaction_finished" }>): string {
	const before = numbers.format(event.tokensBefore);
	const parts = [
		event.tokensAfter === undefined
			? `${before} tokens before`
			: `${before} → ${numbers.format(event.tokensAfter)} tokens`,
	];
	if (event.kept > 0) parts.push(`${plural(event.kept, "message")} kept`);
	if (event.costUsd !== undefined) parts.push(`$${event.costUsd.toFixed(4)}`);
	return `◇ context compacted: ${parts.join(" · ")}`;
}

function compactionFailedLine(event: Extract<AtelierEvent, { type: "compaction_finished" }>): string {
	return `compaction failed: ${event.error ?? "no reason given"}`;
}

/** The main agent's header: backend, model, authentication and, when they are not the usual, its effort and its mode. */
export function startedLine(event: Extract<AtelierEvent, { type: "session_started" }>): string {
	const effort = event.effort === undefined ? "" : ` · effort ${event.effort}`;
	const mode =
		event.permissionMode === undefined || event.permissionMode === "normal" ? "" : ` · mode ${event.permissionMode}`;
	return `atelier · ${event.backend} · ${event.model} · ${event.authSource}${effort}${mode}`;
}

/** `profile cheap (local-pin) · verifier claude-code/claude-sonnet-5-5 thinking medium`; the default profile by its origin alone. */
export function profileLine(
	profile: NonNullable<Extract<AtelierEvent, { type: "session_started" }>["profile"]>,
): string {
	const head = profile.name === undefined ? `profile ${profile.origin}` : `profile ${profile.name} (${profile.origin})`;
	const roles = Object.entries(profile.roles).map(([role, { backend, model, thinking }]) => {
		const parts = [role];
		if (model !== undefined) parts.push(backend === undefined ? model : `${backend}/${model}`);
		if (thinking !== undefined) parts.push(`thinking ${thinking}`);
		return parts.join(" ");
	});
	return [head, ...roles].join(" · ");
}

/**
 * The turn's cost by part, under its tokens line, with who ran in each part when it says so;
 * undefined when the turn had a single part, which the total already says. Without `prices`, each part's requests
 * or tokens only.
 */
export function phasesLine(
	event: Extract<AtelierEvent, { type: "turn_finished" }>,
	sessionBackend: string | undefined,
	{ prices = true }: { prices?: boolean } = {},
): string | undefined {
	const phases = Object.entries(event.phases ?? {}) as [TurnPhase, PhaseSpent][];
	if (phases.length < 2) return undefined;
	const part = ([phase, spent]: [TurnPhase, PhaseSpent]) => {
		const agents = phaseAgents(spent.agents ?? [], sessionBackend);
		const used = phaseSpent(spent, prices);
		return agents === "" ? `${phase} ${used}` : `${phase} ${used} on ${agents}`;
	};
	return `phases: ${phases.map(part).join(" · ")}`;
}

/**
 * `codex/gpt-5.5 medium, claude-haiku-5-5`: each distinct model and effort once, the backend only when it is not the
 * session's; the effort the backend applied when none was asked shows as `effective high`.
 */
function phaseAgents(agents: PhaseAgent[], sessionBackend: string | undefined): string {
	const described = agents.map(({ backend, model, effort, effectiveEffort }) => {
		const who = backend === sessionBackend ? model : `${backend}/${model}`;
		if (effort !== undefined) return `${who} ${effort}`;
		return effectiveEffort === undefined ? who : `${who} effective ${effectiveEffort}`;
	});
	return [...new Set(described)].join(", ");
}

/** `$0.0300 (3 req)`, or `3 req` without `prices`; the tokens only when neither the cost nor the requests are known. */
function phaseSpent({ usage, requests, costUsd }: PhaseSpent, prices: boolean): string {
	const count = requests === undefined ? undefined : `${requests} req`;
	if (costUsd !== undefined && prices)
		return count === undefined ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(4)} (${count})`;
	return count ?? `${numbers.format(usage.input + usage.output)} tokens`;
}

const UNSANDBOXED_EFFECT = "every command asks for approval in normal mode, and goes to the classifier in auto mode";

/** What the auto-mode classifier decided about a call; its reason comes from a model, so hidden characters are shown. */
function classifiedLine(event: Extract<AtelierEvent, { type: "permission_classified" }>): string {
	const reason = visibleText(event.reason).text;
	switch (event.decision) {
		case "allow":
			return `auto: allowed — ${reason}`;
		case "deny":
			return `auto: denied — ${reason}`;
		case "undecided":
			return `auto: undecided — ${reason}; asking you`;
	}
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** `path` relative to `cwd` when it is inside it; as it is otherwise. */
export function pathInCwd(path: string, cwd: string | undefined): string {
	if (cwd === undefined || !isAbsolute(path)) return path;
	const shown = relative(cwd, path);
	return shown.startsWith("..") || isAbsolute(shown) ? path : shown;
}

/** A round's `error` is its reason. */
const withReason = (error: string | undefined) => (error === undefined ? {} : { reason: error });

/** What is left to decide: the cause and its value, then the reason (it lists the unverified requirements); without a cause, as before. */
export function verificationUndecided(event: Extract<AtelierEvent, { type: "verification_finished" }>): string {
	const reason = event.reason === undefined ? "" : ` · ${event.reason}`;
	if (event.cause !== undefined) return `${describeRefusal(event)}${reason}`;
	if (event.openDefects.length === 0 && event.reason !== undefined) return event.reason;
	return `${plural(event.openDefects.length, "open defect")}${reason}`;
}

export function stepText(step: ReviewStep): string {
	switch (step.type) {
		case "lens_started":
			return `lens ${step.lens}`;
		case "lens_finished":
			return step.ok ? `lens ${step.lens} done · ${plural(step.findings, "finding")}` : `lens ${step.lens} failed`;
		case "refuter_started":
			return `refuting ${plural(step.findings, "finding")}`;
		case "refuter_finished":
			return `${step.confirmed} confirmed · ${step.refuted} refuted${step.downgraded ? ` · ${step.downgraded} downgraded` : ""}`;
		case "correction_started":
			return `correcting (budget ${plural(step.budget, "line")})`;
		case "correction_finished":
			return step.ok ? `correction done · ${plural(step.used ?? 0, "line")}` : "correction failed";
		case "validator_started":
			return `validating ${plural(step.findings, "finding")}`;
		case "validator_finished":
			return `${step.resolved} resolved · ${step.unresolved} unresolved`;
	}
}

/** Turns core events into terminal output. Keeps track of the line so tool and token lines start clean. */
export class Renderer {
	readonly #options: RendererOptions;
	/** The calls under way, by id: what each line names once the call finishes. */
	readonly #tools = new Map<string, { tool: string; input: JsonValue }>();
	/** The profile the header last said: a later session_started without one repeats it. */
	#profile: NonNullable<Extract<AtelierEvent, { type: "session_started" }>["profile"]> | undefined;
	/** The backend the header last said: the phases line names another backend only. */
	#backend: string | undefined;
	#atLineStart = true;
	/** The turn in which the "not sandboxed" line was printed: its sandbox warning would say the same. */
	#unsandboxedTurn: string | undefined;
	/**
	 * Turns, counting the current one, in which a cache miss is the expected
	 * result of a compaction that rewrote the history on purpose.
	 */
	#expectedMissTurns = 0;
	/** Subagents, by task call, whose next cache miss is the expected result of their own compaction. */
	readonly #childMissExpected = new Set<string>();
	/** A non-recoverable error or an errored turn happened since the last reset. */
	failed = false;

	constructor(options: RendererOptions) {
		this.#options = options;
	}

	resetTurn(): void {
		this.failed = false;
	}

	/** Writes text to stdout, tracking whether the cursor is at the start of a line. */
	write(text: string): void {
		if (text === "") return;
		this.#options.stdout(text);
		this.#atLineStart = text.endsWith("\n");
	}

	endLine(): void {
		if (!this.#atLineStart) this.write("\n");
	}

	#style(style: Style, text: string): string {
		return this.#options.color ? styleText(style, text) : text;
	}

	#line(text: string): void {
		this.endLine();
		this.write(`${text}\n`);
	}

	/** A subagent's event: indented, and never a failure of the parent's turn, which judges the task result itself. */
	#renderChild(event: AtelierEvent): void {
		switch (event.type) {
			case "session_started":
				this.#line(this.#style("dim", `  ↳ ${event.agent ?? "subagent"} · ${event.model}`));
				return;
			case "text_delta":
				this.#writeIndented(event.text);
				return;
			case "tool_call_started":
				this.#tools.set(event.callId, { tool: event.tool, input: event.input });
				return;
			case "tool_call_finished": {
				const { tool, input } = this.#tools.get(event.callId) ?? { tool: "tool", input: null };
				this.#tools.delete(event.callId);
				const mark = event.ok ? this.#style("green", "✓") : this.#style("red", "✗");
				this.#line(`${CHILD}${this.#style("cyan", "▸")} ${shownTool(tool, event.summary, input)} ${mark}`);
				this.#blocked(event.blocked, `${CHILD}  `);
				return;
			}
			case "permission_classified":
				this.#line(`${CHILD}  ${classifiedLine(event)}`);
				return;
			case "turn_finished":
				this.#line(`${CHILD}${this.#style("dim", tokensLine(event))}`);
				return;
			case "compaction_started":
				this.#line(`${CHILD}${this.#style("dim", compactingLine(event))}`);
				return;
			case "compaction_finished":
				if (!event.ok) {
					this.#warn(`${CHILD}${compactionFailedLine(event)}`);
					return;
				}
				if (event.parentCallId !== undefined) this.#childMissExpected.add(event.parentCallId);
				this.#line(`${CHILD}${this.#style("dim", compactedLine(event))}`);
				return;
			case "cache_miss":
				if (event.parentCallId !== undefined && this.#childMissExpected.delete(event.parentCallId)) {
					this.#line(`${CHILD}${this.#style("dim", `cache miss after compaction: ${event.reason} (expected)`)}`);
					return;
				}
				this.#warn(
					`${CHILD}cache miss: ${event.reason} (${numbers.format(event.missedTokens)} tokens not read from the cache)`,
				);
				return;
			case "error":
				this.endLine();
				this.#options.stderr(`${CHILD}${this.#style("red", `error: ${event.message}`)}\n`);
				return;
			default:
				return;
		}
	}

	#writeIndented(text: string): void {
		const parts = text.split("\n");
		for (const [index, part] of parts.entries()) {
			if (index > 0) this.write("\n");
			if (part === "") {
				// An empty part followed by more text, at a line start, is a blank line, even when the delta
				// boundary split it. It keeps the bar, so the block stays visibly nested.
				if (index < parts.length - 1 && this.#atLineStart) this.write(CHILD.trimEnd());
				continue;
			}
			if (this.#atLineStart) this.write(CHILD);
			this.write(part);
		}
	}

	#renderCompaction(event: Extract<AtelierEvent, { type: "compaction_finished" }>): void {
		if (!event.ok) {
			this.#warn(compactionFailedLine(event));
			return;
		}
		this.#expectedMissTurns = 2;
		this.#line(this.#style("dim", compactedLine(event)));
	}

	/** What the sandbox blocked in a call, one line per cause under the tool line. */
	#blocked(causes: readonly string[] | undefined, indent: string): void {
		for (const cause of causes ?? []) this.#line(this.#style("yellow", `${indent}sandbox blocked: ${cause}`));
	}

	#warn(text: string): void {
		this.endLine();
		this.#options.stderr(`${this.#style("yellow", text)}\n`);
	}

	#receiptPath(path: string): string {
		return pathInCwd(path, this.#options.cwd);
	}

	#renderReviewFinished(event: Extract<AtelierEvent, { type: "review_finished" }>): void {
		const receipt = event.receiptPath === undefined ? undefined : this.#receiptPath(event.receiptPath);
		switch (event.verdict) {
			case "approved": {
				const parts = ["review approved"];
				if (event.correction)
					parts.push(`corrected ${event.correction.used}/${plural(event.correction.budget, "line")}`);
				if (event.followUps.length > 0) parts.push(plural(event.followUps.length, "follow-up"));
				if (receipt) parts.push(`receipt ${receipt}`);
				this.#line(`${this.#style("green", "✓")} ${parts.join(" · ")}`);
				return;
			}
			case "escalated": {
				// The correction is only in the worktree when one was applied; it stays there even when it was too big.
				const left = event.correction ? " — the correction is left in your worktree, review it before committing" : "";
				this.#line(this.#style("red", `✗ review escalated: ${describeRefusal(event)}${left}`));
				for (const found of event.findings) {
					const place = found.line === undefined ? found.path : `${found.path}:${found.line}`;
					this.#line(`  ${found.id} ${found.severity} ${place} — ${found.claim}`);
				}
				if (receipt) this.#line(`  receipt ${receipt}`);
				return;
			}
			case "declined":
				this.#line(this.#style("dim", "◇ review declined"));
				return;
			case "unavailable":
				this.#line(this.#style("dim", `◇ review unavailable: ${describeRefusal(event)}`));
				return;
		}
	}

	#renderVerificationRound(event: Extract<AtelierEvent, { type: "verification_round" }>): void {
		const head = `verify · round ${event.round}`;
		if (!event.ok) {
			this.#line(
				this.#style("yellow", `◇ ${head} · failed: ${describeRefusal({ ...event, ...withReason(event.error) })}`),
			);
			return;
		}
		const parts = [head];
		const { defects } = event;
		const onBase = defects.filter((defect) => defect.onBase).length;
		const found =
			defects.length === 0
				? "no defects"
				: `${plural(defects.length, "defect")} (${defects.map((defect) => defect.severity).join(", ")})${
						onBase > 0 ? `, ${onBase} also on the base` : ""
					}`;
		parts.push(found);
		const verdicts = (["met", "unmet", "unverified"] as const)
			.map((verdict) => [verdict, event.requirements.filter((entry) => entry.verdict === verdict).length] as const)
			.filter(([, count]) => count > 0)
			.map(([verdict, count]) => `${count} ${verdict}`);
		if (verdicts.length > 0) parts.push(verdicts.join(", "));
		if (event.correcting) parts.push("asking the agent to fix them");
		this.#line(this.#style("dim", `◇ ${parts.join(" · ")}`));
	}

	#renderVerificationFinished(event: Extract<AtelierEvent, { type: "verification_finished" }>): void {
		const cost = event.costUsd === undefined ? "" : ` · $${event.costUsd.toFixed(4)}`;
		switch (event.outcome) {
			case "passed":
				this.#line(`${this.#style("green", "✓")} verify passed${cost}`);
				return;
			case "corrected":
				this.#line(
					`${this.#style("green", "✓")} verify passed after a correction · ${plural(event.rounds, "round")}${cost}`,
				);
				return;
			case "failed":
				this.#line(this.#style("red", `✗ verify failed: ${describeRefusal(event)} · needs your decision${cost}`));
				return;
			case "needs_decision":
				this.#line(this.#style("red", `✗ verify: needs your decision · ${verificationUndecided(event)}${cost}`));
				for (const defect of event.openDefects) {
					this.#line(`  ${defect.id} ${defect.severity} — ${defect.summary}`);
					this.#line(`    reproduce: ${defect.reproduction}`);
				}
				return;
		}
	}

	render(event: AtelierEvent): void {
		if (event.parentCallId !== undefined) {
			this.#renderChild(event);
			return;
		}
		switch (event.type) {
			case "session_started":
				this.#line(this.#style("dim", startedLine(event)));
				this.#backend = event.backend;
				this.#profile = event.profile ?? this.#profile;
				if (this.#profile !== undefined) this.#line(this.#style("dim", profileLine(this.#profile)));
				// anthropic-api and opencode-go are billed to their key by choice; only an unexpected bill deserves a warning.
				if (event.authSource !== "subscription" && !API_KEY_BACKENDS.has(event.backend))
					this.#warn(
						`warning: not using a Claude subscription (auth: ${event.authSource}); usage may be billed separately.`,
					);
				return;
			case "text_delta":
				this.write(event.text);
				return;
			case "sandbox_status":
				if (event.sandboxed) {
					this.#line(this.#style("dim", `bash: sandboxed (${event.mechanism ?? "sandbox"})`));
					return;
				}
				this.#unsandboxedTurn = event.turnId;
				this.#warn(`bash: not sandboxed (${event.reason ?? "unavailable"}): ${UNSANDBOXED_EFFECT}`);
				return;
			case "sandbox_warning":
				if (this.#unsandboxedTurn === event.turnId) return;
				this.#warn(`warning: bash runs without a sandbox (${event.reason}): ${UNSANDBOXED_EFFECT}`);
				return;
			case "thinking_delta":
			case "approval_requested":
			case "review_consent_requested":
				return;
			case "tool_call_started":
				this.#tools.set(event.callId, { tool: event.tool, input: event.input });
				return;
			case "tool_call_finished": {
				const { tool, input } = this.#tools.get(event.callId) ?? { tool: "tool", input: null };
				this.#tools.delete(event.callId);
				const mark = event.ok ? this.#style("green", "✓") : this.#style("red", "✗");
				const note = event.truncated ? this.#style("dim", " (truncated)") : "";
				this.#line(`${this.#style("cyan", "▸")} ${shownTool(tool, event.summary, input)} ${mark}${note}`);
				this.#blocked(event.blocked, "  ");
				return;
			}
			case "permission_classified":
				this.#line(`  ${classifiedLine(event)}`);
				return;
			case "turn_finished": {
				if (this.#expectedMissTurns > 0) this.#expectedMissTurns--;
				if (event.stopReason === "error") this.failed = true;
				this.#line(this.#style("dim", tokensLine(event)));
				const phases = phasesLine(event, this.#backend);
				if (phases !== undefined) this.#line(this.#style("dim", phases));
				return;
			}
			case "compaction_started":
				this.#line(this.#style("dim", compactingLine(event)));
				return;
			case "compaction_finished":
				this.#renderCompaction(event);
				return;
			case "cache_miss":
				if (this.#expectedMissTurns > 0) {
					this.#expectedMissTurns = 0;
					this.#line(this.#style("dim", `cache miss after compaction: ${event.reason} (expected)`));
					return;
				}
				this.#warn(
					`cache miss: ${event.reason} (${numbers.format(event.missedTokens)} tokens not read from the cache)`,
				);
				return;
			case "memory_summary_saved": {
				const { input, summary } = summaryCall(event);
				this.#line(
					`${this.#style("cyan", "▸")} ${shownTool(MEMORY_TOOL, summary, input)} ${this.#style("green", "✓")}`,
				);
				return;
			}
			case "memory_status":
				if (event.available) this.#line(this.#style("dim", `memory: ${event.project ?? "on"}`));
				else this.#warn(`no memory: ${event.reason ?? "unavailable"}`);
				return;
			case "mcp_status": {
				const lines = mcpStatusLines(event);
				if (lines.ok !== undefined) this.#line(this.#style("dim", lines.ok));
				for (const warning of lines.warnings) this.#warn(warning);
				return;
			}
			case "project_instructions":
				if (event.files.length > 0) this.#line(this.#style("dim", `instructions: ${event.files.join(", ")}`));
				if (event.dropped.length > 0) this.#warn(`instructions over 32 KiB, left out: ${event.dropped.join(", ")}`);
				return;
			case "skills_loaded": {
				// Names, paths and messages come from a repository's files, loaded without trust: hidden characters are shown.
				const shown = (text: string) => visibleText(text).text;
				if (event.skills.length > 0)
					this.#line(this.#style("dim", `skills: ${event.skills.map(({ name }) => shown(name)).join(", ")}`));
				for (const { path, message } of event.warnings) this.#warn(`skill ${shown(path)}: ${shown(message)}`);
				return;
			}
			case "review_status":
				if (!event.available) this.#warn(`no review: ${event.reason ?? "unavailable"}`);
				return;
			case "review_assessed":
				this.#line(
					this.#style(
						"dim",
						`◇ review ${event.level} · ${event.lenses.length} ${event.lenses.length === 1 ? "lens" : "lenses"}${
							event.lensesReason === undefined ? "" : `: ${event.lenses.join(", ")}`
						}${event.reasons.length > 0 ? ` (${event.reasons.join("; ")})` : ""}${
							event.declaration?.kind === "none" ? ` · declared none: ${event.declaration.reason}` : ""
						}${event.lensesReason === undefined ? "" : ` · lenses chosen: ${event.lensesReason}`}${
							event.since === undefined ? "" : ` · since ${event.since}`
						}${event.baseNote === undefined ? "" : ` · ${event.baseNote}`}${
							event.consent === "session" ? " · allowed for this session" : ""
						}`,
					),
				);
				return;
			case "verification_started":
				this.#line(
					this.#style("dim", `◇ verifying · ${event.items.length === 1 ? "item" : "items"} ${event.items.join(", ")}`),
				);
				return;
			case "verification_round":
				this.#renderVerificationRound(event);
				return;
			case "verification_finished":
				this.#renderVerificationFinished(event);
				return;
			case "review_progress":
				this.#line(this.#style("dim", `◇ review: ${stepText(event.step)}`));
				return;
			case "review_finished":
				this.#renderReviewFinished(event);
				return;
			case "correction_undone": {
				const parts = ["correction undone"];
				if (event.restored.length > 0) parts.push(`restored ${event.restored.join(", ")}`);
				if (event.removed.length > 0) parts.push(`removed ${event.removed.join(", ")}`);
				this.#line(`${this.#style("green", "✓")} ${parts.join(" · ")}`);
				return;
			}
			case "phase_changed":
				this.#line(this.#style("dim", `· ${event.phase}`));
				return;
			case "feature_changed": {
				const done = event.tasks.filter((task) => task.status === "done").length;
				const now = event.tasks.find((task) => task.status === "in_progress");
				const progress = `${done}/${event.tasks.length} done${now ? ` · now ${now.id} ${now.title}` : ""}`;
				this.#line(`${this.#style("magenta", "◆")} ${event.title} (${event.path}): ${progress}`);
				return;
			}
			case "rate_limit": {
				if (event.status === "allowed") return;
				const details = [
					event.window,
					event.resetsAt === undefined ? undefined : `resets ${new Date(event.resetsAt * 1000).toLocaleString()}`,
				].filter((part) => part !== undefined);
				this.#warn(`rate limit: ${event.status}${details.length > 0 ? ` (${details.join(", ")})` : ""}`);
				return;
			}
			case "error":
				// `memory_summary_saved` already said it.
				if (event.code === SUMMARY_WARNING) return;
				if (!event.recoverable) this.failed = true;
				this.endLine();
				this.#options.stderr(`${this.#style("red", `error: ${event.message}`)}\n`);
				return;
		}
	}
}

/**
 * The `mcp_status` lines: the servers that are up or connecting, then a warning for each failed or invalid server and
 * each problem of the file. Server text is shown with its control characters as markers.
 */
export function mcpStatusLines(event: Extract<AtelierEvent, { type: "mcp_status" }>): {
	ok?: string;
	warnings: string[];
} {
	const shown = (text: string) => visibleText(text).text;
	const firstLine = (text: string) => shown(text.trim().split("\n")[0] ?? "");
	const up = event.servers.flatMap(({ name, state, tools }) => {
		if (state === "connected") return [`${shown(name)} (${tools.length} ${tools.length === 1 ? "tool" : "tools"})`];
		if (state === "connecting") return [`${shown(name)} (connecting)`];
		return [];
	});
	const warnings = [
		...event.servers.flatMap(({ name, state, error }) => {
			if (state === "failed")
				return [`mcp: ${shown(name)} failed: ${firstLine(error ?? "unknown error")} (/mcp for details)`];
			if (state === "invalid") return [`mcp: ${shown(name)} is invalid: ${firstLine(error ?? "")}`];
			if (state === "needs_auth") return [`mcp: ${shown(name)} needs sign-in: run atelier mcp login ${shown(name)}`];
			return [];
		}),
		...event.problems.map((problem) => `mcp: ${firstLine(problem)}`),
	];
	return { ...(up.length === 0 ? {} : { ok: `mcp: ${up.join(", ")}` }), warnings };
}

/**
 * A tool's name and summary as a line shows them: the model and MCP servers choose them, so control characters show as
 * markers. A memory call says what it did and how it came out, `memory search "query" · 2 results`.
 */
function shownTool(tool: string, summary: string, input: JsonValue): string {
	if (tool === MEMORY_TOOL) {
		const { outcome, warning } = memoryOutcome(input, summary);
		return [
			`${tool} ${memoryCallText(input)}`,
			outcome,
			...(warning === undefined ? [] : [`warning: ${warning}`]),
		].join(" · ");
	}
	return `${visibleText(tool).text} ${visibleText(summary).text}`;
}
