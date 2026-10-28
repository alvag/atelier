import { type AtelierEvent, visibleText } from "@atelier/core";
import { type Component, Container, Markdown, Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { API_KEY_BACKENDS, phasesLine, profileLine, Renderer, startedLine } from "../render.ts";
import { ActivityBlock } from "./activity-block.ts";
import { PromptBlock } from "./prompt.ts";
import { ReviewBlock } from "./review-block.ts";
import { markdownTheme, type Paint, Shade } from "./style.ts";
import { AgentGroup, type CardView, ToolCard } from "./tool-card.ts";
import { VerifyCard } from "./verify-card.ts";

const shown = (text: string) => visibleText(text).text;

/** A line with nothing on it: no text and no style, so a shaded row is not one. */
const isBlank = (line: string) => line.trim() === "";

/** `lines` without the blank lines at their start and end. */
function withoutBlankEdges(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlank(lines[start] ?? "")) start++;
	while (end > start && isBlank(lines[end - 1] ?? "")) end--;
	return lines.slice(start, end);
}

/** The local time `at`, in hours and minutes as the system says them (`14:42`, `2:42 PM`). */
const clockTime = (at: Date) => at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** `◇ 12.3s · 3 requests · 14:42`, what a turn took and when it ended; its cost is left to the footer and `/status`. */
function finishedLine(event: Extract<AtelierEvent, { type: "turn_finished" }>, endedAt: Date): string {
	const parts: string[] = [];
	if (event.durationMs !== undefined) parts.push(`${(event.durationMs / 1000).toFixed(1)}s`);
	if (event.requests !== undefined) parts.push(`${event.requests} request${event.requests === 1 ? "" : "s"}`);
	if (event.stopReason !== "end_turn") parts.push(event.stopReason);
	return `◇ ${parts.length === 0 ? "done" : parts.join(" · ")} · ${clockTime(endedAt)}`;
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

/** The agent's text after a `●`, the rest of its lines under the text, so it stands apart from its activity. */
class AgentText implements Component {
	readonly #markdown: Markdown;
	readonly #paint: Paint;

	constructor(markdown: Markdown, paint: Paint) {
		this.#markdown = markdown;
		this.#paint = paint;
	}

	invalidate(): void {
		this.#markdown.invalidate();
	}

	render(width: number): string[] {
		const lines = withoutBlankEdges(this.#markdown.render(Math.max(1, width - 3)));
		return lines.map((line, index) => (index === 0 ? ` ${this.#paint("bold", "●")} ${line}` : `   ${line}`));
	}
}

/**
 * The transcript: each prompt, the agent's text as Markdown, each tool call as a folded card with the subagent it
 * ran, each verification as a folded card with its verdict on every requirement, each review as one block that grows
 * with it, the verifier's and the review roles' work grouped under one line each in them, and the rest of the events as the CLI's own lines. The
 * phase is left to the footer.
 */
export class Conversation extends Container {
	readonly view: CardView = { expanded: false };
	readonly #paint: Paint;
	readonly #shade: Shade;
	readonly #now: () => Date;
	readonly #renderer: Renderer;
	/** What the renderer wrote for the event being shown. */
	#notes = "";
	/** The Markdown block the agent's text goes on, until something else is shown after it. */
	#text: { block: Markdown; source: string } | undefined;
	/** The block the agent's calls go in, until something else is shown after it. */
	#activity: ActivityBlock | undefined;
	/** The feature and task last said to be in progress, so the line comes only when it changes. */
	#task: string | undefined;
	readonly #cards = new Map<string, ToolCard>();
	/** The verifier's and the review roles' groups, by call and agent: a review gives all its roles one call id. */
	readonly #groups = new Map<string, AgentGroup>();
	/** The header last said: the yolo warning is repeated only when it changes. */
	#header: string | undefined;
	/** What the session said it runs with and loaded, kept for `/status` instead of the transcript; the newest of each. */
	readonly #status = new Map<"header" | "bash" | "instructions" | "skills" | "memory", string>([
		["header", ""],
		["bash", ""],
		["instructions", ""],
		["skills", ""],
		["memory", ""],
	]);
	#backend: string | undefined;
	readonly #cwd: string;
	/** Each review's block by its id, and the one the latest assessment started, which has no id until it is asked or run. */
	readonly #reviews = new Map<string, ReviewBlock>();
	#assessed: ReviewBlock | undefined;
	readonly #verifications = new Map<string, VerifyCard>();

	/** `now` tells the time a turn ends at, and how long each call took. */
	constructor(paint: Paint, cwd: string, shade = new Shade(false), now: () => Date = () => new Date()) {
		super();
		this.#paint = paint;
		this.#shade = shade;
		this.#now = now;
		this.#cwd = cwd;
		const write = (text: string) => {
			this.#notes += text;
		};
		// Plain on purpose: the lines are shown with markers for control characters, which would also break its colors.
		this.#renderer = new Renderer({ stdout: write, stderr: write, color: false, cwd });
	}

	/** The lines `/status` prints: the session's header and profile, the sandbox, and what it loaded. */
	status(): string[] {
		return [...this.#status.values()].filter((line) => line !== "").flatMap((line) => line.split("\n"));
	}

	/** Toggles the details of every tool card. */
	toggleCards(): void {
		this.view.expanded = !this.view.expanded;
		this.view.epoch = (this.view.epoch ?? 0) + 1;
	}

	/** Opens or folds all of the model's thinking. */
	toggleThinking(): void {
		this.view.thinking = this.view.thinking !== true;
		this.view.epoch = (this.view.epoch ?? 0) + 1;
	}

	/** A click goes to the block on its row, laid out as `render` lays the blocks out. */
	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		let top = 0;
		for (const child of this.children) {
			const lines = child.render(event.width);
			const start = lines.findIndex((line) => !isBlank(line));
			const height = withoutBlankEdges(lines).length;
			if (height === 0) continue;
			if (event.y >= top && event.y < top + height) {
				const y = event.y - top + start;
				const result = child.handleMouse?.({ ...event, y, height: lines.length });
				if (!result?.handled) return undefined;
				const target = { component: child, originX: event.screenX - event.x, originY: event.screenY - y };
				return { ...result, handled: true, target: { ...target, width: event.width, height: lines.length } };
			}
			top += height + 1;
		}
		return undefined;
	}

	/** The user's prompt: on the shade, or after `❯` without it. */
	prompt(text: string): void {
		if (this.#shade.on) this.#add(new PromptBlock(shown(text), this.#paint, this.#shade));
		else this.#add(new Text(`${this.#paint(["bold", "cyan"], "❯")} ${shown(text)}`, 1, 0));
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
				// A model that omits its thinking still sends empty deltas: they show nothing.
				if (event.text !== "") this.#activityBlock().think(shown(event.text));
				return;
			case "approval_requested":
			case "phase_changed":
			// The queue shows over the editor.
			case "queue_update":
				return;
			case "queued_message":
				this.prompt(event.text);
				return;
			case "review_assessed": {
				const block = new ReviewBlock(this.view, this.#paint, this.#cwd);
				block.event(event);
				this.#assessed = block;
				this.#add(block);
				return;
			}
			case "review_consent_requested":
			case "review_progress":
			case "review_finished":
				this.#review(event.reviewId).event(event);
				return;
			case "verification_started":
			case "verification_round":
			case "verification_finished":
				this.#verification(event.verifyId).event(event);
				return;
			case "tool_call_started": {
				const card = new ToolCard(event.tool, event.input, this.view, this.#paint, event.callId, this.#now);
				this.#cards.set(event.callId, card);
				this.#activityBlock().add(card);
				return;
			}
			case "feature_changed":
				this.#taskChanged(event);
				return;
			case "tool_call_finished":
				this.#cards.get(event.callId)?.finish(event);
				return;
			case "session_started":
				this.#started(event);
				return;
			case "session_configured":
				this.note(configuredLine(event));
				return;
			case "compaction_finished": {
				// Prices are left to the footer and `/status`.
				const { costUsd: _costUsd, ...unpriced } = event;
				this.#rendered(unpriced);
				return;
			}
			// What runs as usual goes to `/status`; what runs with less protection, or failed to load, stays in sight.
			// A later loss replaces what `/status` said before, so it never shows a protection gone.
			case "sandbox_status":
				if (event.sandboxed) this.#status.set("bash", `bash: sandboxed (${shown(event.mechanism ?? "sandbox")})`);
				else {
					this.#status.set("bash", `bash: not sandboxed (${shown(event.reason ?? "unavailable")})`);
					this.#rendered(event);
				}
				return;
			case "sandbox_warning":
				this.#status.set("bash", `bash: not sandboxed (${shown(event.reason)})`);
				this.#rendered(event);
				return;
			case "memory_status":
				if (event.available) this.#status.set("memory", `memory: ${shown(event.project ?? "on")}`);
				else {
					this.#status.set("memory", `no memory: ${shown(event.reason ?? "unavailable")}`);
					this.#rendered(event);
				}
				return;
			case "project_instructions":
				if (event.files.length > 0) this.#status.set("instructions", `instructions: ${shown(event.files.join(", "))}`);
				this.#rendered({ ...event, files: [] });
				return;
			case "skills_loaded":
				if (event.skills.length > 0)
					this.#status.set("skills", `skills: ${event.skills.map(({ name }) => shown(name)).join(", ")}`);
				this.#rendered({ ...event, skills: [] });
				return;
			case "turn_finished": {
				// The renderer counts the turns after a compaction, which decide whether a cache miss is expected.
				this.#renderer.render(event);
				this.#renderer.endLine();
				this.#notes = "";
				const phases = phasesLine(event, this.#backend, false);
				const finished = finishedLine(event, this.#now());
				this.note(phases === undefined ? finished : `${finished}\n${phases}`);
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
		this.#status.set("header", shown(header));
		if (header !== this.#header && event.permissionMode === "yolo")
			this.note("mode: yolo · what normal mode would ask runs without asking", true);
		this.#header = header;
		if (event.authSource !== "subscription" && !API_KEY_BACKENDS.has(event.backend))
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
		const review = this.#reviews.get(parent) ?? this.#verifications.get(parent);
		if (review) {
			review.child(event);
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

	/** The block the agent's calls go in: the open one, or a new one after everything so far. */
	#activityBlock(): ActivityBlock {
		if (this.#activity === undefined) {
			const block = new ActivityBlock(this.view, this.#paint);
			this.#add(block);
			this.#activity = block;
		}
		return this.#activity;
	}

	/** `◆ now T2 Footer` when the task in progress changes; the rest of a feature's progress is the footer's and the panel's. */
	#taskChanged(event: Extract<AtelierEvent, { type: "feature_changed" }>): void {
		const now = event.tasks.find((task) => task.status === "in_progress");
		const key = now === undefined ? undefined : `${event.path}\0${now.id}`;
		if (now !== undefined && key !== this.#task) this.note(`◆ now ${shown(now.id)} ${shown(now.title)}`);
		this.#task = key;
	}

	/** The block of review `reviewId`: the one the latest assessment started, or a new one when there is none. */
	#review(reviewId: string): ReviewBlock {
		let block = this.#reviews.get(reviewId);
		if (block === undefined) {
			block = this.#assessed ?? new ReviewBlock(this.view, this.#paint, this.#cwd);
			if (block !== this.#assessed) this.#add(block);
			this.#assessed = undefined;
			this.#reviews.set(reviewId, block);
		}
		return block;
	}

	/** The card of verification `verifyId`, a new one at its first event. */
	#verification(verifyId: string): VerifyCard {
		let card = this.#verifications.get(verifyId);
		if (card === undefined) {
			card = new VerifyCard(verifyId, this.view, this.#paint);
			this.#verifications.set(verifyId, card);
			this.#add(card);
		}
		return card;
	}

	/** The CLI's line for an event, as a block of its own. */
	#rendered(event: AtelierEvent): void {
		this.#renderer.render(event);
		this.#renderer.endLine();
		const text = shown(this.#notes.trimEnd());
		this.#notes = "";
		if (text !== "") this.#add(new Text(text, 1, 0));
	}

	#appendText(delta: string): void {
		if (this.#text === undefined) {
			const block = new Markdown("", 0, 0, markdownTheme(this.#paint));
			this.#activity?.end();
			this.#activity = undefined;
			this.#text = { block, source: "" };
			this.addChild(new AgentText(block, this.#paint));
		}
		this.#text.source += delta;
		this.#text.block.setText(shown(this.#text.source));
	}

	/**
	 * Each block with one blank line between it and the next, as Codex spaces its transcript, and one after the last,
	 * which separates the next session's; the blank lines a block has at its edges are left out, so none is doubled.
	 */
	override render(width: number): string[] {
		const blocks = this.children
			.map((child) => withoutBlankEdges(child.render(width)))
			.filter((lines) => lines.length > 0);
		return blocks.flatMap((lines) => [...lines, ""]);
	}

	/** Shows a block after everything so far; the agent's next text starts a block of its own. */
	#add(block: Component): void {
		this.#text = undefined;
		this.#activity?.end();
		this.#activity = undefined;
		this.addChild(block);
	}
}
