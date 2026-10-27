import { type AtelierEvent, type FeatureTask, type ReviewStep, visibleText } from "@atelier/core";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { stepText } from "../render.ts";
import type { Paint } from "./style.ts";

const shown = (text: string) => visibleText(text).text;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

type FeatureChanged = Extract<AtelierEvent, { type: "feature_changed" }>;
type VerificationRound = Extract<AtelierEvent, { type: "verification_round" }>;

/** `1/5 done · now T2 Hot profile`. */
function progress(feature: FeatureChanged): string {
	const done = feature.tasks.filter((task) => task.status === "done").length;
	const now = feature.tasks.find((task) => task.status === "in_progress");
	return `${done}/${feature.tasks.length} done${now === undefined ? "" : ` · now ${shown(now.id)} ${shown(now.title)}`}`;
}

/** `✓ T1 Hot model · 34e37d5`: a task with a mark for its state, and the state itself when it is not the usual ones. */
function taskLine(task: FeatureTask, paint: Paint): string {
	const title = `${shown(task.id)} ${shown(task.title)}`;
	switch (task.status) {
		case "done":
			return `${paint("green", "✓")} ${title}${task.commit === undefined ? "" : paint("dim", ` · ${shown(task.commit)}`)}`;
		case "in_progress":
			return `${paint("cyan", "▸")} ${paint("bold", title)}`;
		case "blocked":
			return `${paint("yellow", "!")} ${title}${paint("yellow", " · blocked")}`;
		case "dropped":
			return paint("dim", `~ ${title} · dropped`);
		case "pending":
		case undefined:
			return `${paint("dim", "·")} ${title}`;
		default:
			return `${paint("dim", "·")} ${title} · ${shown(task.status)}`;
	}
}

/** The active ODD feature over the editor: one line folded, each task with its state unfolded. */
export class FeaturePanel implements Component {
	expanded = false;
	#feature: FeatureChanged | undefined;
	readonly #paint: Paint;

	constructor(paint: Paint) {
		this.#paint = paint;
	}

	toggle(): void {
		this.expanded = !this.expanded;
	}

	/** Takes the main agent's `feature_changed`; a subagent's says nothing about the session's feature. */
	event(event: AtelierEvent): void {
		if (event.type === "feature_changed" && event.parentCallId === undefined) this.#feature = event;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const feature = this.#feature;
		if (feature === undefined) return [];
		const paint = this.#paint;
		const tail = this.expanded ? shown(feature.path) : "Ctrl+T tasks";
		const head = ` ${paint("magenta", "◆")} ${paint("bold", shown(feature.title))} · ${progress(feature)}${paint("dim", ` · ${tail}`)}`;
		const lines = [head, ...(this.expanded ? feature.tasks.map((task) => `   ${taskLine(task, paint)}`) : [])];
		return lines.map((line) => truncateToWidth(line, width));
	}
}

/** `risk ✓ 2 findings`, `reliability …`: a lens as the review status shows it. */
type LensState = "running" | { ok: boolean; findings: number };

/** A review's lenses and the step it is on; the verifier's items and its latest round. */
interface Running {
	review?: { id: string; lenses: Map<string, LensState>; step?: ReviewStep };
	verify?: { id: string; items: number[]; round?: VerificationRound };
}

/** `1 met, 1 unmet`: how many requirements got each verdict. */
export function verdictCounts(round: VerificationRound): string {
	return (["met", "unmet", "unverified"] as const)
		.map((verdict) => [verdict, round.requirements.filter((entry) => entry.verdict === verdict).length] as const)
		.filter(([, count]) => count > 0)
		.map(([verdict, count]) => `${count} ${verdict}`)
		.join(", ");
}

/**
 * What the review and the verifier are doing while they run, over the editor; each line goes when its work ends. A
 * turn that ends clears what it left, for an interrupted run that sends no end.
 */
export class WorkStatus implements Component {
	#running: Running = {};
	readonly #paint: Paint;

	constructor(paint: Paint) {
		this.#paint = paint;
	}

	event(event: AtelierEvent): void {
		if (event.parentCallId !== undefined) return;
		switch (event.type) {
			case "review_progress": {
				const review =
					this.#running.review?.id === event.reviewId
						? this.#running.review
						: { id: event.reviewId, lenses: new Map<string, LensState>() };
				const { step } = event;
				if (step.type === "lens_started") review.lenses.set(step.lens, "running");
				else if (step.type === "lens_finished") review.lenses.set(step.lens, { ok: step.ok, findings: step.findings });
				else review.step = step;
				this.#running.review = review;
				return;
			}
			case "review_finished":
				if (this.#running.review?.id === event.reviewId) delete this.#running.review;
				return;
			case "verification_started":
				this.#running.verify = { id: event.verifyId, items: event.items };
				return;
			case "verification_round":
				if (this.#running.verify?.id === event.verifyId) this.#running.verify.round = event;
				return;
			case "verification_finished":
				if (this.#running.verify?.id === event.verifyId) delete this.#running.verify;
				return;
			case "turn_finished":
				this.#running = {};
				return;
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];
		const { review, verify } = this.#running;
		if (verify !== undefined) lines.push(this.#verifyLine(verify));
		if (review !== undefined) lines.push(this.#reviewLine(review));
		return lines.map((line) => truncateToWidth(` ${this.#paint("cyan", "◇")} ${line}`, width));
	}

	#reviewLine(review: NonNullable<Running["review"]>): string {
		const paint = this.#paint;
		const parts = ["review"];
		for (const [lens, state] of review.lenses) {
			const name = shown(lens);
			if (state === "running") parts.push(`${name} ${paint("dim", "…")}`);
			else if (!state.ok) parts.push(`${name} ${paint("red", "✗")}`);
			else parts.push(`${name} ${paint("green", "✓")} ${plural(state.findings, "finding")}`);
		}
		const { step } = review;
		// A step that started is running; one that finished says what it left.
		if (step !== undefined) parts.push(`${shown(stepText(step))}${step.type.endsWith("_started") ? "…" : ""}`);
		return parts.join(paint("dim", " · "));
	}

	#verifyLine(verify: NonNullable<Running["verify"]>): string {
		const items = `${verify.items.length === 1 ? "item" : "items"} ${verify.items.join(", ")}`;
		const { round } = verify;
		if (round === undefined) return `verify · ${items} · round 1…`;
		const said = round.ok ? verdictCounts(round) : "failed";
		const next = round.correcting ? "the agent is correcting…" : `round ${round.round + 1}…`;
		return `verify · ${items} · round ${round.round}${said === "" ? "" : `: ${said}`} · ${next}`;
	}
}

/** The verifier's verdict on each requirement, with the evidence of those not met, and the defects of the round. */
export function verificationLines(round: VerificationRound, paint: Paint): string[] {
	if (!round.ok) return [];
	const marks = { met: paint("green", "✓"), unmet: paint("red", "✗"), unverified: paint("yellow", "?") };
	const requirements = round.requirements.map((entry) => {
		const evidence = entry.verdict === "met" || entry.evidence === "" ? "" : ` — ${shown(entry.evidence)}`;
		return `  ${marks[entry.verdict]} ${shown(entry.id)} ${entry.verdict} · ${shown(entry.requirement)}${evidence}`;
	});
	const defects = round.defects.map(
		(defect) =>
			`  ${shown(defect.id)} ${defect.severity} · ${shown(defect.summary)}${defect.onBase ? paint("dim", " (also on the base)") : ""}`,
	);
	return [...requirements, ...defects];
}

/** `◇ review: risk 2 findings · 0 confirmed · 2 refuted`: what a review's steps left, in one line. */
export function reviewSummary(steps: ReviewStep[]): string | undefined {
	const lenses = steps
		.filter((step) => step.type === "lens_finished")
		.map((step) =>
			step.ok ? `${shown(step.lens)} ${plural(step.findings, "finding")}` : `${shown(step.lens)} failed`,
		);
	const others = steps
		.filter((step) => step.type.endsWith("_finished") && step.type !== "lens_finished")
		.map((step) => shown(stepText(step)));
	const parts = [...(lenses.length === 0 ? [] : [lenses.join(", ")]), ...others];
	return parts.length === 0 ? undefined : `◇ review: ${parts.join(" · ")}`;
}
