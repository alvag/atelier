import { type AtelierEvent, type ReviewStep, visibleText } from "@atelier/core";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { stepText } from "../render.ts";
import type { Paint } from "./style.ts";

type VerificationRound = Extract<AtelierEvent, { type: "verification_round" }>;

const shown = (text: string) => visibleText(text).text;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

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
