import { isAbsolute, relative } from "node:path";
import { styleText } from "node:util";
import { type AtelierEvent, cacheHitRate, type ReviewStep } from "@atelier/core";

export interface RendererOptions {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	color: boolean;
	/** Receipt paths under it are shown relative to it. */
	cwd?: string;
}

type Style = Parameters<typeof styleText>[0];

const numbers = new Intl.NumberFormat("en-US");
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

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function stepText(step: ReviewStep): string {
	switch (step.type) {
		case "lens_started":
			return `lens ${step.lens}`;
		case "lens_finished":
			return step.ok ? `lens ${step.lens} done · ${plural(step.findings, "finding")}` : `lens ${step.lens} failed`;
		case "refuter_started":
			return `refuting ${plural(step.findings, "finding")}`;
		case "refuter_finished":
			return `${step.confirmed} confirmed · ${step.refuted} refuted`;
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
	readonly #tools = new Map<string, string>();
	#atLineStart = true;
	/**
	 * Turns, counting the current one, in which a cache miss is the expected
	 * result of a compaction that rewrote the history on purpose.
	 */
	#expectedMissTurns = 0;
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
				this.#tools.set(event.callId, event.tool);
				return;
			case "tool_call_finished": {
				const tool = this.#tools.get(event.callId) ?? "tool";
				this.#tools.delete(event.callId);
				const mark = event.ok ? this.#style("green", "✓") : this.#style("red", "✗");
				this.#line(`${CHILD}${this.#style("cyan", "▸")} ${tool} ${event.summary} ${mark}`);
				return;
			}
			case "turn_finished":
				this.#line(`${CHILD}${this.#style("dim", tokensLine(event))}`);
				return;
			case "cache_miss":
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
			this.#warn(`compaction failed: ${event.error ?? "no reason given"}`);
			return;
		}
		this.#expectedMissTurns = 2;
		const before = numbers.format(event.tokensBefore);
		const parts = [
			event.tokensAfter === undefined
				? `${before} tokens before`
				: `${before} → ${numbers.format(event.tokensAfter)} tokens`,
		];
		if (event.kept > 0) parts.push(`${plural(event.kept, "message")} kept`);
		if (event.costUsd !== undefined) parts.push(`$${event.costUsd.toFixed(4)}`);
		this.#line(this.#style("dim", `◇ context compacted: ${parts.join(" · ")}`));
	}

	#warn(text: string): void {
		this.endLine();
		this.#options.stderr(`${this.#style("yellow", text)}\n`);
	}

	#receiptPath(path: string): string {
		const { cwd } = this.#options;
		if (cwd === undefined || !isAbsolute(path)) return path;
		const shown = relative(cwd, path);
		return shown.startsWith("..") || isAbsolute(shown) ? path : shown;
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
				this.#line(this.#style("red", `✗ review escalated: ${event.reason ?? "no reason given"}${left}`));
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
				this.#line(this.#style("dim", `◇ review unavailable: ${event.reason ?? "no reason given"}`));
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
				this.#line(this.#style("dim", `atelier · ${event.backend} · ${event.model} · ${event.authSource}`));
				// anthropic-api is billed to the API key by choice; only an unexpected bill deserves a warning.
				if (event.authSource !== "subscription" && event.backend !== "anthropic-api")
					this.#warn(
						`warning: not using a Claude subscription (auth: ${event.authSource}); usage may be billed separately.`,
					);
				return;
			case "text_delta":
				this.write(event.text);
				return;
			case "thinking_delta":
			case "approval_requested":
			case "review_consent_requested":
				return;
			case "tool_call_started":
				this.#tools.set(event.callId, event.tool);
				return;
			case "tool_call_finished": {
				const tool = this.#tools.get(event.callId) ?? "tool";
				this.#tools.delete(event.callId);
				const mark = event.ok ? this.#style("green", "✓") : this.#style("red", "✗");
				const note = event.truncated ? this.#style("dim", " (truncated)") : "";
				this.#line(`${this.#style("cyan", "▸")} ${tool} ${event.summary} ${mark}${note}`);
				return;
			}
			case "turn_finished":
				if (this.#expectedMissTurns > 0) this.#expectedMissTurns--;
				if (event.stopReason === "error") this.failed = true;
				this.#line(this.#style("dim", tokensLine(event)));
				return;
			case "compaction_started":
				this.#line(
					this.#style("dim", `◇ compacting context (${event.reason}, ${numbers.format(event.tokens)} tokens)`),
				);
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
			case "memory_status":
				if (event.available) this.#line(this.#style("dim", `memory: ${event.project ?? "on"}`));
				else this.#warn(`no memory: ${event.reason ?? "unavailable"}`);
				return;
			case "project_instructions":
				if (event.files.length > 0) this.#line(this.#style("dim", `instructions: ${event.files.join(", ")}`));
				if (event.dropped.length > 0) this.#warn(`instructions over 32 KiB, left out: ${event.dropped.join(", ")}`);
				return;
			case "review_status":
				if (!event.available) this.#warn(`no review: ${event.reason ?? "unavailable"}`);
				return;
			case "review_assessed":
				this.#line(
					this.#style(
						"dim",
						`◇ review ${event.level} · ${event.lenses.length} ${event.lenses.length === 1 ? "lens" : "lenses"}${
							event.reasons.length > 0 ? ` (${event.reasons.join("; ")})` : ""
						}${event.declaration?.kind === "none" ? ` · declared none: ${event.declaration.reason}` : ""}`,
					),
				);
				return;
			case "review_progress":
				this.#line(this.#style("dim", `◇ review: ${stepText(event.step)}`));
				return;
			case "review_finished":
				this.#renderReviewFinished(event);
				return;
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
				if (!event.recoverable) this.failed = true;
				this.endLine();
				this.#options.stderr(`${this.#style("red", `error: ${event.message}`)}\n`);
				return;
		}
	}
}
