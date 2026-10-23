import { z } from "zod";
import { describeError } from "../events.ts";
import type { Candidate } from "./candidate.ts";
import type { Escalation } from "./risk.ts";
import { extractJson } from "./roles.ts";

/** The verifier gets at most this many rounds: one report, one correction by the main agent, one more report. */
export const VERIFIER_ROUNDS = 2;
/** Files listed in the change summary; the rest are counted. */
const SUMMARY_FILES = 200;

export const VERIFIER_INSTRUCTION = [
	"You are an independent verifier. Another agent changed a high-risk part of this project and declared its risk. You check that the work does what the user asked and that it holds up against hostile input. You did not write it and you owe it nothing.",
	"Your working directory holds two copies of the project: candidate/ (the agent's work at the end of the turn) and base/ (the project before the turn). You have read, grep and bash. bash runs without asking, only inside this directory, and you may write scratch files only here. You cannot edit the user's repository and must not try.",
	"Never install packages and never use the network: no install, add, update or download with pnpm, npm, yarn, pip or any other tool, no curl or wget. The project's installed dependencies are linked into both copies; use those. If something you need is missing, mark the requirement unverified and say what is missing.",
	"Do this, in order:",
	"1. Derive the requirements from the user's request (and the feature document, when one is given). Keep the user's own words where you can.",
	"2. Run probes against candidate/ for each requirement; reading code is not a probe. Include hostile and adversarial inputs aimed at what the declared risk item protects: for a guard or an approval, inputs that try to bypass it; for parsing, malformed, pasted, empty and boundary input; for data, repeated or interrupted operations.",
	"3. Run the project's existing focused tests for the code the change touches when that is cheap. Do not run a slow full suite.",
	"4. Reproduce every defect on candidate/, then run the same steps on base/. A defect that also happens on base/ is pre-existing: report it with onBase true; it is advisory and never blocks. Report only defects you reproduced, never suspicions or style comments.",
	"Severity: blocker = a requirement is not met or a guard can be bypassed; major = wrong behavior a user will hit; minor = rough edge with a workaround.",
	"Requirement verdicts: met (a probe shows it), unmet (a probe shows it is not), unverified (you could not check it; say why). Evidence names the command or input and what you observed.",
	'Your final message is only this JSON object, no other text: {"requirements":[{"id":"R1","requirement":"what the user asked","verdict":"met|unmet|unverified","evidence":"command or input, and what you observed"}],"defects":[{"id":"D1","severity":"blocker|major|minor","summary":"what is wrong","reproduction":"the exact command or steps","candidate":"what candidate/ did","base":"what base/ did","onBase":false}]}. Use an empty defects list when you found none.',
].join("\n");

const requirementSchema = z.object({
	id: z.string().min(1),
	requirement: z.string().min(1),
	verdict: z.enum(["met", "unmet", "unverified"]),
	evidence: z.string().min(1),
});
const defectSchema = z.object({
	id: z.string().min(1),
	severity: z.enum(["blocker", "major", "minor"]),
	summary: z.string().min(1),
	reproduction: z.string().min(1),
	candidate: z.string().min(1),
	base: z.string().min(1),
	onBase: z.boolean(),
});
const reportSchema = z.object({ requirements: z.array(requirementSchema), defects: z.array(defectSchema) });

export type VerifierRequirement = z.infer<typeof requirementSchema>;
export type VerifierDefect = z.infer<typeof defectSchema>;
export interface VerifierReport {
	requirements: VerifierRequirement[];
	defects: VerifierDefect[];
}
export type ParsedReport = { ok: true; report: VerifierReport } | { ok: false; error: string };

/** The verifier's reply. Anything but a complete report is a failure, never a pass. */
export function parseVerifierReport(text: string): ParsedReport {
	const json = extractJson(text);
	if (json === undefined) return { ok: false, error: "The reply has no JSON object with requirements and defects." };
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		return { ok: false, error: `The reply is not valid JSON: ${describeError(error)}` };
	}
	const parsed = reportSchema.safeParse(value);
	if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
	for (const [name, entries] of [
		["requirement", parsed.data.requirements],
		["defect", parsed.data.defects],
	] as const) {
		const seen = new Set<string>();
		for (const { id } of entries) {
			if (seen.has(id)) return { ok: false, error: `The reply uses the ${name} id ${id} more than once.` };
			seen.add(id);
		}
	}
	return { ok: true, report: parsed.data };
}

/** Defects the main agent must fix: serious, and not already there before the change. */
export function blockingDefects(report: VerifierReport): VerifierDefect[] {
	return report.defects.filter(
		(defect) => !defect.onBase && (defect.severity === "blocker" || defect.severity === "major"),
	);
}

export interface VerifierPromptInput {
	/** The user's words for this turn, verbatim. */
	request: string;
	/** The feature document, as a path inside the verifier's directory. */
	feature?: string;
	declaration: readonly Escalation[];
	candidate: Candidate;
	round: number;
	/** What the previous round found that the agent was asked to fix. */
	handedBack?: readonly VerifierDefect[];
	/** What the copy lacks, or how its dependencies were made available. */
	dependencies: string;
}

export function buildVerifierPrompt(input: VerifierPromptInput): string {
	const { candidate } = input;
	const lines = ["The user's request for this turn, verbatim:", "<request>", input.request, "</request>", ""];
	if (input.feature !== undefined)
		lines.push(`Feature document (a copy; read it first, its specs are what the user asked for): ${input.feature}`, "");
	lines.push("The agent's risk declaration:");
	for (const { items, reason } of input.declaration) lines.push(`- item ${items.join(", ")}: ${reason}`);
	lines.push("", `Change under verification (base ${candidate.baseCommit.slice(0, 7)} -> candidate):`);
	const shown = candidate.files.slice(0, SUMMARY_FILES);
	for (const file of shown)
		lines.push(`- ${file.status} ${file.path}${file.binary ? " (binary)" : ` (+${file.added} -${file.deleted})`}`);
	if (candidate.files.length > shown.length)
		lines.push(`- ... and ${candidate.files.length - shown.length} more files`);
	lines.push(
		`${candidate.files.length} files, ${candidate.changedLines} changed lines.`,
		...(candidate.baseNote === undefined ? [] : [candidate.baseNote]),
		"",
		`Dependencies: ${input.dependencies}`,
		"",
		`Round ${input.round} of ${VERIFIER_ROUNDS}.`,
	);
	if (input.handedBack && input.handedBack.length > 0) {
		lines.push(
			"The defects you reported in the previous round were handed to the agent, which changed the work. Check each one again, then look for new ones:",
		);
		for (const defect of input.handedBack) lines.push(`- ${defect.id} [${defect.severity}] ${defect.summary}`);
	}
	return lines.join("\n");
}

/** The message that asks the main agent to fix what the verifier reproduced. */
export function verifierCorrectionMessage(defects: readonly VerifierDefect[]): string {
	return [
		"An independent verifier reproduced these defects in your change, and they do not happen on the version before your change:",
		...defects.map(
			(d) =>
				`- ${d.id} [${d.severity}] ${d.summary}\n  reproduce: ${d.reproduction}\n  on your change: ${d.candidate}\n  before your change: ${d.base}`,
		),
		"",
		"Fix them in this turn and declare the risk again if it changed. Do not commit. The verifier will run once more.",
	].join("\n");
}
