import type { Candidate } from "./candidate.ts";
import { SEVERITY_CRITERION } from "./findings.ts";
import { runGit } from "./git.ts";
import type { Lens } from "./risk.ts";

/** A lens prompt, instruction included, may not exceed this; over it the review is refused, never cut. */
export const LENS_CONTEXT_LIMIT_BYTES = 200 * 1024;
/** A change too large for one prompt is split into at most this many parts; past them it is refused. */
export const MAX_LENS_PARTS = 4;

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
	/** The full patch from readPatch, or the part of it this prompt holds. */
	patch: string;
	/** Why the change got its risk level, as reported by the assessment. */
	reasons: readonly string[];
	/** Which part of a split change the patch is; absent for a whole change. */
	part?: { index: number; count: number };
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
		...(input.part === undefined ? [] : [partNote(input.part)]),
		"Patch:",
		input.patch,
	].join("\n");
	const bytes = Buffer.byteLength(instruction) + Buffer.byteLength(prompt);
	if (bytes > LENS_CONTEXT_LIMIT_BYTES)
		return { ok: false, code: "lens_context_budget_exceeded", bytes, limit: LENS_CONTEXT_LIMIT_BYTES };
	return { ok: true, instruction, prompt, bytes };
}

function partNote(part: { index: number; count: number }): string {
	return `Part ${part.index} of ${part.count}: this patch holds only some of the changed files; the other parts are reviewed separately. Read the rest of the change with read or grep when you need it.`;
}

/**
 * The prompts of every lens of a review. A change whose prompt fits every lens gets exactly the one prompt
 * `buildLensPrompt` gives. Otherwise the patch is split by file, keeping the files in path order (so a folder
 * stays together), into the fewest parts that each fit the lens with the longest instruction, so every lens
 * gets the same parts. A file whose patch cannot fit alone, or more than `MAX_LENS_PARTS` parts, is refused.
 */
export function buildLensPrompts(
	input: Omit<LensPromptInput, "lens" | "part">,
	lenses: readonly Lens[],
): { ok: true; prompts: Map<Lens, string[]> } | BudgetExceeded {
	const whole = new Map<Lens, string[]>();
	let largest: BudgetExceeded | undefined;
	for (const lens of lenses) {
		const built = buildLensPrompt({ ...input, lens });
		if (built.ok) whole.set(lens, [built.prompt]);
		else if (largest === undefined || built.bytes > largest.bytes) largest = built;
	}
	if (largest === undefined) return { ok: true, prompts: whole };

	const widest = lenses.reduce((a, b) =>
		Buffer.byteLength(LENS_INSTRUCTIONS[b]) > Buffer.byteLength(LENS_INSTRUCTIONS[a]) ? b : a,
	);
	// The patch is the prompt's last line, so a part's size is the prompt without a patch plus the patch's bytes.
	const empty = buildLensPrompt({ ...input, lens: widest, patch: "", part: { index: 1, count: MAX_LENS_PARTS } });
	const room = LENS_CONTEXT_LIMIT_BYTES - (empty.ok ? empty.bytes : LENS_CONTEXT_LIMIT_BYTES);
	const parts: string[][] = [];
	let size = 0;
	for (const file of splitPatch(input.patch)) {
		const bytes = Buffer.byteLength(file);
		if (bytes > room) return { ...largest, bytes: LENS_CONTEXT_LIMIT_BYTES - room + bytes };
		const last = parts.at(-1);
		if (last !== undefined && size + bytes <= room) {
			last.push(file);
			size += bytes;
		} else {
			parts.push([file]);
			size = bytes;
		}
	}
	if (parts.length > MAX_LENS_PARTS) return largest;

	const prompts = new Map<Lens, string[]>();
	for (const lens of lenses) {
		const built: string[] = [];
		for (const [index, files] of parts.entries()) {
			const part = { index: index + 1, count: parts.length };
			const prompt = buildLensPrompt({ ...input, lens, patch: files.join(""), part });
			if (!prompt.ok) return prompt;
			built.push(prompt.prompt);
		}
		prompts.set(lens, built);
	}
	return { ok: true, prompts };
}

/** The patch of each file, in the order git gave them; joined again they are the whole patch. */
function splitPatch(patch: string): string[] {
	return patch.split(/(?=^diff --git )/m).filter((file) => file.length > 0);
}

/** The full patch between the candidate's trees; one over what `MAX_LENS_PARTS` parts can hold is refused, not cut. */
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
		{ cwd: candidate.root, limitBytes: MAX_LENS_PARTS * LENS_CONTEXT_LIMIT_BYTES + 1 },
	);
	if (result.code !== 0) throw new Error(result.stderr.trim() || `git diff-tree exited with ${result.code}`);
	if (result.stdout.length > MAX_LENS_PARTS * LENS_CONTEXT_LIMIT_BYTES)
		return {
			ok: false,
			code: "lens_context_budget_exceeded",
			bytes: result.stdout.length,
			limit: LENS_CONTEXT_LIMIT_BYTES,
		};
	return { ok: true, patch: result.stdout.toString("utf8") };
}
