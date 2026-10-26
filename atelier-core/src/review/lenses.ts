import type { Candidate } from "./candidate.ts";
import { SEVERITY_CRITERION } from "./findings.ts";
import { runGit } from "./git.ts";
import type { Lens } from "./risk.ts";

/** A lens prompt, instruction included, may not exceed this; over it the review is refused, never cut. */
export const LENS_CONTEXT_LIMIT_BYTES = 200 * 1024;

const COMMON = [
	"You are a read-only code reviewer: you cannot change files or run commands, only read and grep the frozen change.",
	'Judge only the change in the patch. Code it did not touch is out of scope, except to report a problem there with cause "pre-existing".',
	"Report only what the frozen tree proves, with path:line evidence you checked with read or grep. Do not speculate.",
	`Severity: blocker, critical, warning or suggestion. ${SEVERITY_CRITERION} A defect that is real but not severe is a warning; a style or maintainability remark is a suggestion.`,
	'Cause: "candidate" if the change introduced it, "pre-existing" if it was already there, "unknown" if you cannot tell.',
	'Your final message is only this JSON object, no other text: {"findings":[{"id":"1","lens":"<your lens>","severity":"blocker|critical|warning|suggestion","cause":"candidate|pre-existing|unknown","path":"src/x.ts","line":12,"claim":"what is wrong","evidence":"src/x.ts:12 and why"}]}. Use an empty list when there is nothing to report.',
].join("\n");

const CONCERN: Record<Lens, string> = {
	risk: "Lens: risk. Look for anything that could expose, lose or irreversibly change data, credentials, permissions or contracts others rely on: leaked secrets, missing authorization checks, destructive operations without a guard, unsafe input handling, changed formats or schemas.",
	resilience:
		"Lens: resilience. Look at behaviour under failure: unhandled errors, missing retries or timeouts, partial writes that leave inconsistent state, resources not released, races and concurrent access, and what happens when a dependency is slow or down.",
	readability:
		"Lens: readability. Look at what other people read or depend on: public APIs and names, error and user-facing messages, docs and comments that no longer match the code, and structure that hides intent or makes the next change hard.",
	reliability:
		"Lens: reliability. Look at logic and behaviour that tests should pin: wrong conditions, off-by-one and boundary errors, unhandled cases, changed behaviour without a test, and edge cases the change makes reachable.",
};

export const LENS_INSTRUCTIONS: Record<Lens, string> = {
	risk: `${CONCERN.risk}\n${COMMON}`,
	resilience: `${CONCERN.resilience}\n${COMMON}`,
	readability: `${CONCERN.readability}\n${COMMON}`,
	reliability: `${CONCERN.reliability}\n${COMMON}`,
};

export interface LensPromptInput {
	candidate: Candidate;
	lens: Lens;
	/** The full patch from readPatch. */
	patch: string;
	/** Why the change got its risk level, as reported by the assessment. */
	reasons: readonly string[];
}

export type BudgetExceeded = {
	ok: false;
	code: "lens_context_budget_exceeded";
	/** Size found; when the patch was cut while reading, at least this. */
	bytes: number;
	limit: number;
};

export type LensPrompt = { ok: true; instruction: string; prompt: string; bytes: number } | BudgetExceeded;

/**
 * The user prompt of a lens: the risk reasons, the changed files and the whole
 * patch. The size counted against the budget is the instruction plus this prompt.
 * Over the budget the answer is a refusal; nothing is ever truncated.
 */
export function buildLensPrompt(input: LensPromptInput): LensPrompt {
	const instruction = LENS_INSTRUCTIONS[input.lens];
	const files = input.candidate.files.map(
		(file) => `- ${file.path} (${file.status}, ${file.binary ? "binary" : `+${file.added} -${file.deleted}`})`,
	);
	const prompt = [
		"Risk reasons:",
		...(input.reasons.length > 0 ? input.reasons.map((reason) => `- ${reason}`) : ["- none"]),
		"",
		"Changed files:",
		...files,
		"",
		"Patch:",
		input.patch,
	].join("\n");
	const bytes = Buffer.byteLength(instruction) + Buffer.byteLength(prompt);
	if (bytes > LENS_CONTEXT_LIMIT_BYTES)
		return { ok: false, code: "lens_context_budget_exceeded", bytes, limit: LENS_CONTEXT_LIMIT_BYTES };
	return { ok: true, instruction, prompt, bytes };
}

/** The full patch between the candidate's trees; a patch over the budget is refused, not cut. */
export async function readPatch(candidate: Candidate): Promise<{ ok: true; patch: string } | BudgetExceeded> {
	const result = await runGit(
		[
			"diff-tree",
			"-p",
			"-r",
			"--no-renames",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			candidate.base,
			candidate.tree,
		],
		{ cwd: candidate.root, limitBytes: LENS_CONTEXT_LIMIT_BYTES + 1 },
	);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git diff-tree exited with ${result.code}`);
	if (result.stdout.length > LENS_CONTEXT_LIMIT_BYTES)
		return {
			ok: false,
			code: "lens_context_budget_exceeded",
			bytes: result.stdout.length,
			limit: LENS_CONTEXT_LIMIT_BYTES,
		};
	return { ok: true, patch: result.stdout.toString("utf8") };
}
