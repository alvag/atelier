import { type AtelierEvent, type ReviewStep, visibleText } from "@atelier/core";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { phasesLine, profileLine, Renderer, startedLine } from "../render.ts";
import { reviewSummary, verificationLines } from "./odd.ts";
import { markdownTheme, type Paint } from "./style.ts";
import { AgentGroup, type CardView, ToolCard } from "./tool-card.ts";

const shown = (text: string) => visibleText(text).text;

/** `◇ 12.3s · 3 requests · $0.0421`, what a turn took; the footer keeps the totals. */
function finishedLine(event: Extract<AtelierEvent, { type: "turn_finished" }>): string {
	const parts: string[] = [];
	if (event.durationMs !== undefined) parts.push(`${(event.durationMs / 1000).toFixed(1)}s`);
	if (event.requests !== undefined) parts.push(`${event.requests} request${event.requests === 1 ? "" : "s"}`);
	if (event.costUsd !== undefined) parts.push(`$${event.costUsd.toFixed(4)}`);
	if (event.stopReason !== "end_turn") parts.push(event.stopReason);
	return `◇ ${parts.length === 0 ? "done" : parts.join(" · ")}`;
}

/** `◇ model claude-sonnet-5-5 · effort high · mode auto`, and the backend change with what it carried. */
function configuredLine(event: Extract<AtelierEvent, { type: "session_configured" }>): string {
	const parts = [`backend ${shown(event.backend)}`];
	if (event.model !== undefined) parts.push(`model ${shown(event.model)}`);
	if (event.thinking !== undefined) parts.push(`effort ${shown(event.thinking)}`);
	parts.push(`mode ${event.permissionMode}`);
	if (event.profile !== undefined) parts.push(`profile ${shown(event.profile.name ?? event.profile.origin)}`);
	const change = event.backendChange;
	const moved =
		change === undefined
			? ""
			: ` · moved from ${shown(change.from)}${change.summarized ? " with a summary of the conversation" : ""}`;
	return `◇ now ${parts.join(" · ")}${moved}`;
}

/**
 * The transcript: each prompt, the agent's text as Markdown, each tool call as a folded card with the subagent it
 * ran, the verifier's and the review roles' work grouped under one line each, the verifier's verdict on each
 * requirement, a review's steps summed up before its verdict, and the rest of the events as the CLI's own lines. The
 * phase is left to the footer.
 */
export class Conversation extends Container {
	readonly view: CardView = { expanded: false };
	readonly #paint: Paint;
	readonly #renderer: Renderer;
	/** What the renderer wrote for the event being shown. */
	#notes = "";
	/** The Markdown block the agent's text goes on, until something else is shown after it. */
	#text: { block: Markdown; source: string } | undefined;
	readonly #cards = new Map<string, ToolCard>();
	/** The verifier's and the review roles' groups, by call and agent: a review gives all its roles one call id. */
	readonly #groups = new Map<string, AgentGroup>();
	/** The header last shown: it is repeated only when it changes. */
	#header: string | undefined;
	#backend: string | undefined;
	/** The steps of each review so far, summed up when it finishes. */
	readonly #reviews = new Map<string, ReviewStep[]>();

	constructor(paint: Paint, cwd: string) {
		super();
		this.#paint = paint;
		const write = (text: string) => {
			this.#notes += text;
		};
		// Plain on purpose: the lines are shown with markers for control characters, which would also break its colors.
		this.#renderer = new Renderer({ stdout: write, stderr: write, color: false, cwd });
	}

	/** Toggles the details of every tool card. */
	toggleCards(): void {
		this.view.expanded = !this.view.expanded;
	}

	/** The user's prompt, after a blank line that separates it from the turn before. */
	prompt(text: string): void {
		this.#add(new Spacer(1));
		this.#add(new Text(`${this.#paint(["bold", "cyan"], "❯")} ${shown(text)}`, 1, 0));
	}

	/** A line of the client's own, such as the answer to `/mode`; `warn` shows it in yellow. */
	note(text: string, warn = false): void {
		this.#add(new Text(warn ? this.#paint("yellow", text) : this.#paint("dim", text), 1, 0));
	}

	/** Text shown as it is, such as a resumed session's transcript. */
	plain(text: string): void {
		this.#add(new Text(text.trimEnd(), 1, 0));
	}

	event(event: AtelierEvent): void {
		if (event.parentCallId !== undefined) {
			this.#child(event, event.parentCallId);
			return;
		}
		switch (event.type) {
			case "text_delta":
				this.#appendText(event.text);
				return;
			case "thinking_delta":
			case "approval_requested":
			case "review_consent_requested":
			case "phase_changed":
				return;
			case "review_progress":
				this.#reviews.set(event.reviewId, [...(this.#reviews.get(event.reviewId) ?? []), event.step]);
				return;
			case "review_finished": {
				const summary = reviewSummary(this.#reviews.get(event.reviewId) ?? []);
				this.#reviews.delete(event.reviewId);
				if (summary !== undefined) this.note(summary);
				this.#rendered(event);
				return;
			}
			case "verification_round":
				this.#rendered(event, verificationLines(event, this.#paint));
				return;
			case "tool_call_started": {
				const card = new ToolCard(event.tool, event.input, this.view, this.#paint);
				this.#cards.set(event.callId, card);
				this.#add(card);
				return;
			}
			case "tool_call_finished":
				this.#cards.get(event.callId)?.finish(event);
				return;
			case "session_started":
				this.#started(event);
				return;
			case "session_configured":
				this.note(configuredLine(event));
				return;
			case "turn_finished": {
				// The renderer counts the turns after a compaction, which decide whether a cache miss is expected.
				this.#renderer.render(event);
				this.#renderer.endLine();
				this.#notes = "";
				const phases = phasesLine(event, this.#backend);
				this.note(phases === undefined ? finishedLine(event) : `${finishedLine(event)}\n${phases}`);
				return;
			}
			default:
				this.#rendered(event);
		}
	}

	#started(event: Extract<AtelierEvent, { type: "session_started" }>): void {
		this.#backend = event.backend;
		const header = [startedLine(event), ...(event.profile === undefined ? [] : [profileLine(event.profile)])].join(
			"\n",
		);
		if (header !== this.#header) this.note(shown(header));
		this.#header = header;
		if (event.authSource !== "subscription" && event.backend !== "anthropic-api")
			this.note(
				`warning: not using a Claude subscription (auth: ${event.authSource}); usage may be billed separately.`,
				true,
			);
	}

	/** An event of a subagent goes to the card of its call; the verifier's and a review role's, to their group. */
	#child(event: AtelierEvent, parent: string): void {
		const card = this.#cards.get(parent);
		if (card) {
			card.child(event);
			return;
		}
		const key = `${parent}\0${event.agent ?? ""}`;
		let group = this.#groups.get(key);
		if (!group) {
			group = new AgentGroup(this.view, this.#paint);
			this.#groups.set(key, group);
			this.#add(group);
		}
		group.add(event);
	}

	/** The CLI's line for an event, and the `more` lines after it (already shown with markers), as a block of its own. */
	#rendered(event: AtelierEvent, more: string[] = []): void {
		this.#renderer.render(event);
		this.#renderer.endLine();
		const text = [shown(this.#notes.trimEnd()), ...more].filter((line) => line !== "").join("\n");
		this.#notes = "";
		if (text !== "") this.#add(new Text(text, 1, 0));
	}

	#appendText(delta: string): void {
		if (this.#text === undefined) {
			const block = new Markdown("", 1, 0, markdownTheme(this.#paint));
			this.#text = { block, source: "" };
			this.addChild(block);
		}
		this.#text.source += delta;
		this.#text.block.setText(shown(this.#text.source));
	}

	/** Shows a block after everything so far; the agent's next text starts a block of its own. */
	#add(block: Component): void {
		this.#text = undefined;
		this.addChild(block);
	}
}
