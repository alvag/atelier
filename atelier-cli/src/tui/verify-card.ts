import { type AtelierEvent, describeRefusal, type VerifyDefect, visibleText } from "@atelier/core";
import type { Component } from "@earendil-works/pi-tui";
import { verificationUndecided } from "../render.ts";
import { blockLines, RoleGroups } from "./block.ts";
import type { Paint } from "./style.ts";
import type { CardView } from "./tool-card.ts";

const shown = (text: string) => visibleText(text).text;
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

type Started = Extract<AtelierEvent, { type: "verification_started" }>;
type Round = Extract<AtelierEvent, { type: "verification_round" }>;
type Finished = Extract<AtelierEvent, { type: "verification_finished" }>;

/** One verification as the transcript shows it: its start, each round and its end. */
export interface VerifyState {
	verifyId: string;
	started?: Started;
	rounds: Round[];
	finished?: Finished;
}

/** The verification after one of the main agent's events about it; any other event says nothing about it. */
export function verifyAfter(state: VerifyState, event: AtelierEvent): VerifyState {
	if (event.parentCallId !== undefined) return state;
	if (
		(event.type === "verification_started" ||
			event.type === "verification_round" ||
			event.type === "verification_finished") &&
		event.verifyId !== state.verifyId
	)
		return state;
	switch (event.type) {
		case "verification_started":
			return { ...state, started: event };
		case "verification_round":
			return { ...state, rounds: [...state.rounds, event] };
		case "verification_finished":
			return { ...state, finished: event };
		default:
			return state;
	}
}

/** `round 1 · 1 defect (major) · 1 met, 1 unmet · asking the agent to fix them`, as the line CLI says it. */
function roundLine(round: Round): string {
	const head = `round ${round.round}`;
	if (!round.ok)
		return `${head} · failed: ${shown(describeRefusal({ ...round, ...(round.error === undefined ? {} : { reason: round.error }) }))}`;
	const { defects } = round;
	const onBase = defects.filter((defect) => defect.onBase).length;
	const parts = [
		head,
		defects.length === 0
			? "no defects"
			: `${plural(defects.length, "defect")} (${defects.map((defect) => defect.severity).join(", ")})${
					onBase > 0 ? `, ${onBase} also on the base` : ""
				}`,
	];
	const verdicts = (["met", "unmet", "unverified"] as const)
		.map((verdict) => [verdict, round.requirements.filter((entry) => entry.verdict === verdict).length] as const)
		.filter(([, count]) => count > 0)
		.map(([verdict, count]) => `${count} ${verdict}`);
	if (verdicts.length > 0) parts.push(verdicts.join(", "));
	if (round.correcting) parts.push("asking the agent to fix them");
	return parts.join(" · ");
}

/** `D1 major · yolo accepted`, and how to reproduce it when the card is open. */
function defectLines(defect: VerifyDefect, indent: string, expanded: boolean, paint: Paint): string[] {
	const base = defect.onBase ? paint("dim", " (also on the base)") : "";
	const lines = [`${indent}${shown(defect.id)} ${defect.severity} · ${shown(defect.summary)}${base}`];
	if (expanded) lines.push(paint("dim", `${indent}  reproduce: ${shown(defect.reproduction)}`));
	return lines;
}

/**
 * Each requirement's verdict, with its evidence when the card is open (or, with `openUnmet`, when it is not met), then
 * the round's defects.
 */
function roundLines(round: Round, expanded: boolean, paint: Paint, openUnmet = false): string[] {
	const marks = { met: paint("green", "✓"), unmet: paint("red", "✗"), unverified: paint("yellow", "?") };
	const lines = [paint("dim", `  ${roundLine(round)}`)];
	for (const entry of round.requirements) {
		lines.push(`    ${marks[entry.verdict]} ${shown(entry.id)} ${entry.verdict} · ${shown(entry.requirement)}`);
		const open = expanded || (openUnmet && entry.verdict !== "met");
		if (open && entry.evidence !== "") lines.push(paint("dim", `      evidence: ${shown(entry.evidence)}`));
	}
	for (const defect of round.defects) lines.push(...defectLines(defect, "    ", expanded, paint));
	return lines;
}

/** How the verification ended, and the defects left to decide on; its cost is left to the footer and `/status`. */
function finishedLines(finished: Finished, expanded: boolean, paint: Paint): string[] {
	switch (finished.outcome) {
		case "passed":
			return [`${paint("green", "✓")} verify passed`];
		case "corrected":
			return [`${paint("green", "✓")} verify passed after a correction · ${plural(finished.rounds, "round")}`];
		case "failed":
			return [paint("red", `✗ verify failed: ${shown(describeRefusal(finished))} · needs your decision`)];
		case "needs_decision":
			return [
				paint("red", `✗ verify: needs your decision · ${shown(verificationUndecided(finished))}`),
				// What is left to decide is shown open, as the line CLI shows it.
				...finished.openDefects.flatMap((defect) => defectLines(defect, "  ", true, paint)),
			];
	}
}

/**
 * A verification's card: `head` (`▸ verify · items 2, 6`, `▾` when open, and the round running) goes before the
 * verifier's line and `rest` after it. Folded, it says each requirement's verdict and each defect; open, also the
 * declaration, the evidence and how to reproduce each defect. A verification that needs the user's decision shows,
 * even folded, the evidence of the last round's requirements not met and how to reproduce each open defect. Every
 * line is wrapped to the width.
 */
export function verifyCardLines(
	state: VerifyState,
	expanded: boolean,
	width: number,
	paint: Paint,
): { head: string[]; rest: string[] } {
	const items = state.started?.items ?? [];
	const parts = [
		"verify",
		...(items.length === 0 ? [] : [`${items.length === 1 ? "item" : "items"} ${items.join(", ")}`]),
	];
	if (state.finished === undefined) parts.push(`round ${state.rounds.length + 1}…`);
	const head = [`${paint("cyan", expanded ? "▾" : "▸")} ${parts.join(" · ")}`];
	if (expanded)
		for (const entry of state.started?.declaration ?? [])
			head.push(paint("dim", `  declared items ${entry.items.join(", ")}: ${shown(entry.reason)}`));
	const undecided = state.finished?.outcome === "needs_decision";
	const rest = [
		...state.rounds.flatMap((round, at) =>
			roundLines(round, expanded, paint, undecided && at === state.rounds.length - 1),
		),
		...(state.finished === undefined ? [] : finishedLines(state.finished, expanded, paint)),
	];
	return { head: blockLines(head, width), rest: blockLines(rest, width) };
}

/** A verification in the transcript, which grows with its rounds; Ctrl+O opens it with the tool cards. */
export class VerifyCard implements Component {
	state: VerifyState;
	readonly #roles: RoleGroups;
	readonly #view: CardView;
	readonly #paint: Paint;

	constructor(verifyId: string, view: CardView, paint: Paint) {
		this.state = { verifyId, rounds: [] };
		this.#roles = new RoleGroups(view, paint);
		this.#view = view;
		this.#paint = paint;
	}

	event(event: AtelierEvent): void {
		this.state = verifyAfter(this.state, event);
	}

	/** An event of the verifier or of the correction it asked for. */
	child(event: AtelierEvent): void {
		this.#roles.add(event);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { head, rest } = verifyCardLines(this.state, this.#view.expanded, width, this.#paint);
		return [...head, ...this.#roles.render(width), ...rest];
	}
}
