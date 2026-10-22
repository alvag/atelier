import { styleText } from "node:util";
import { type AtelierEvent, cacheHitRate } from "@atelier/core";

export interface RendererOptions {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	color: boolean;
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
	return `tokens: ${parts.join(" · ")}`;
}

/** Turns core events into terminal output. Keeps track of the line so tool and token lines start clean. */
export class Renderer {
	readonly #options: RendererOptions;
	readonly #tools = new Map<string, string>();
	#atLineStart = true;
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
				// A blank line inside the text keeps the bar, so the block stays visibly nested.
				if (index > 0 && index < parts.length - 1 && this.#atLineStart) this.write(CHILD.trimEnd());
				continue;
			}
			if (this.#atLineStart) this.write(CHILD);
			this.write(part);
		}
	}

	#warn(text: string): void {
		this.endLine();
		this.#options.stderr(`${this.#style("yellow", text)}\n`);
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
				if (event.stopReason === "error") this.failed = true;
				this.#line(this.#style("dim", tokensLine(event)));
				return;
			case "cache_miss":
				this.#warn(
					`cache miss: ${event.reason} (${numbers.format(event.missedTokens)} tokens not read from the cache)`,
				);
				return;
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
