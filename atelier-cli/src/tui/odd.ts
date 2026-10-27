import { type AtelierEvent, visibleText } from "@atelier/core";
import type { Paint } from "./style.ts";

type VerificationRound = Extract<AtelierEvent, { type: "verification_round" }>;

const shown = (text: string) => visibleText(text).text;

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
