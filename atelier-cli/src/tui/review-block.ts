import { type AtelierEvent, describeRefusal, type ReviewFinding, type ReviewStep, visibleText } from "@atelier/core";
import type { Component } from "@earendil-works/pi-tui";
import { pathInCwd, stepText } from "../render.ts";
import { blockLines, RoleGroups } from "./block.ts";
import type { Paint } from "./style.ts";
import type { CardView } from "./tool-card.ts";

const shown = (text: string) => visibleText(text).text;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

type Assessed = Extract<AtelierEvent, { type: "review_assessed" }>;
type Finished = Extract<AtelierEvent, { type: "review_finished" }>;

/** One review as the transcript shows it: its assessment, whether the user was asked, its steps and its result. */
export interface ReviewState {
	reviewId?: string;
	assessed?: Assessed;
	consentAsked?: boolean;
	steps: ReviewStep[];
	finished?: Finished;
}

/** The review after one of the main agent's events; a subagent's say nothing about it. */
export function reviewAfter(state: ReviewState, event: AtelierEvent): ReviewState {
	if (event.parentCallId !== undefined) return state;
	switch (event.type) {
		case "review_assessed":
			return { ...state, assessed: event };
		case "review_consent_requested":
			return { ...state, reviewId: event.reviewId, consentAsked: true };
		case "review_progress":
			return { ...state, reviewId: event.reviewId, steps: [...state.steps, event.step] };
		case "review_finished":
			return { ...state, reviewId: event.reviewId, finished: event };
		default:
			return state;
	}
}

/** `◇ review high · 12 lines in 2 files · lenses risk, reliability`, then why, the declaration and the base. */
function assessedLines(assessed: Assessed | undefined, paint: Paint): string[] {
	if (assessed === undefined) return [paint("cyan", "◇ review")];
	const parts = [
		`review ${shown(assessed.level)}`,
		`${plural(assessed.changedLines, "line")} in ${plural(assessed.files.length, "file")}`,
	];
	if (assessed.lenses.length > 0) parts.push(`lenses ${assessed.lenses.map(shown).join(", ")}`);
	if (!assessed.reviewDue) parts.push("no review due");
	const lines = [`${paint("cyan", "◇")} ${parts.join(" · ")}`];
	const more = (text: string) => lines.push(paint("dim", `  ${text}`));
	if (assessed.reasons.length > 0) more(`why: ${assessed.reasons.map(shown).join("; ")}`);
	if (assessed.lensesReason !== undefined) more(`lenses chosen: ${shown(assessed.lensesReason)}`);
	const declaration = assessed.declaration;
	if (declaration?.kind === "none") more(`declared none: ${shown(declaration.reason)}`);
	if (declaration?.kind === "items")
		for (const entry of declaration.items) more(`declared items ${entry.items.join(", ")}: ${shown(entry.reason)}`);
	const base = [
		...(assessed.since === undefined ? [] : [`since ${shown(assessed.since)}`]),
		...(assessed.baseNote === undefined ? [] : [shown(assessed.baseNote)]),
	];
	if (base.length > 0) more(base.join(" · "));
	return lines;
}

const findingLine = (found: ReviewFinding) =>
	`  ${shown(found.id)} ${shown(found.severity)} ${shown(found.line === undefined ? found.path : `${found.path}:${found.line}`)} — ${shown(found.claim)}`;

/** The verdict, with the correction, the follow-ups left and the cost; the blocking findings; the receipt. */
function finishedLines(finished: Finished, paint: Paint, cwd: string | undefined): string[] {
	const tail = [
		...(finished.verdict === "approved" || finished.verdict === "escalated"
			? [plural(finished.followUps.length, "follow-up")]
			: []),
		...(finished.costUsd === undefined ? [] : [`$${finished.costUsd.toFixed(4)}`]),
	];
	const withTail = (head: string) => [head, ...tail].join(" · ");
	const lines: string[] = [];
	switch (finished.verdict) {
		case "approved": {
			const corrected = finished.correction
				? [`corrected ${finished.correction.used}/${plural(finished.correction.budget, "line")}`]
				: [];
			lines.push(`${paint("green", "✓")} ${withTail(["review approved", ...corrected].join(" · "))}`);
			break;
		}
		case "escalated": {
			// The correction is only in the worktree when one was applied; it stays there even when it was too big.
			const left = finished.correction ? " — the correction is left in your worktree, review it before committing" : "";
			lines.push(paint("red", withTail(`✗ review escalated: ${shown(describeRefusal(finished))}${left}`)));
			break;
		}
		case "declined":
			lines.push(paint("dim", withTail("◇ review declined")));
			break;
		case "unavailable":
			lines.push(paint("dim", withTail(`◇ review unavailable: ${shown(describeRefusal(finished))}`)));
			break;
	}
	lines.push(...finished.findings.map(findingLine));
	if (finished.receiptPath !== undefined)
		lines.push(paint("dim", `  receipt ${shown(pathInCwd(finished.receiptPath, cwd))}`));
	return lines;
}

/**
 * A review's block: `head` (the assessment, the question while it waits, each step) goes before its roles' lines and
 * `result` after them. Every line is wrapped to the width.
 */
export function reviewBlockLines(
	state: ReviewState,
	width: number,
	paint: Paint,
	cwd: string | undefined,
): { head: string[]; result: string[] } {
	const head = assessedLines(state.assessed, paint);
	if (state.consentAsked && state.steps.length === 0 && state.finished === undefined)
		head.push(paint("yellow", "  waiting for your answer"));
	head.push(...state.steps.map((step) => paint("dim", `  · ${shown(stepText(step))}`)));
	const result = state.finished === undefined ? [] : finishedLines(state.finished, paint, cwd);
	return { head: blockLines(head, width), result: blockLines(result, width) };
}

/** A review in the transcript, which grows with its events; each role's work goes in a line under its steps. */
export class ReviewBlock implements Component {
	state: ReviewState = { steps: [] };
	readonly #roles: RoleGroups;
	readonly #paint: Paint;
	readonly #cwd: string | undefined;

	constructor(view: CardView, paint: Paint, cwd: string | undefined) {
		this.#roles = new RoleGroups(view, paint);
		this.#paint = paint;
		this.#cwd = cwd;
	}

	event(event: AtelierEvent): void {
		this.state = reviewAfter(this.state, event);
	}

	/** An event of one of the review's roles. */
	child(event: AtelierEvent): void {
		this.#roles.add(event);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { head, result } = reviewBlockLines(this.state, width, this.#paint, this.#cwd);
		return [...head, ...this.#roles.render(width), ...result];
	}
}
