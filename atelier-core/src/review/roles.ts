import { z } from "zod";
import { describeError } from "../events.ts";

export const REFUTER_INSTRUCTION = [
	"You are a read-only refuter: you cannot change files or run commands, only read and grep the frozen change.",
	"You receive severe findings that reviewers raised against a change. Try to refute each one: check the claim and its evidence in the frozen tree.",
	'Answer "refuted" only when the tree proves the claim wrong (a guard, a test, or code the reviewer missed), and say what proves it. Answer "confirmed" when the claim holds or you cannot disprove it.',
	'Your final message is only this JSON object, no other text: {"verdicts":[{"id":"RL-001","verdict":"confirmed|refuted","reason":"what you checked and found, with path:line"}]}. Answer every finding id you were given.',
].join("\n");

export const VALIDATOR_INSTRUCTION = [
	"You are a read-only validator: you cannot change files or run commands, only read and grep the corrected frozen tree.",
	"You receive findings that were confirmed against an earlier version of the change, which has since been corrected. For each one, check in the corrected tree whether the defect is gone.",
	"Answer resolved true only when the tree proves the defect is fixed, with path:line evidence; otherwise false and say what is still wrong.",
	'Your final message is only this JSON object, no other text: {"results":[{"id":"RL-001","resolved":true,"evidence":"what you checked, with path:line"}]}. Answer every finding id you were given.',
].join("\n");

const verdictsSchema = z.object({
	verdicts: z.array(
		z.object({ id: z.string().min(1), verdict: z.enum(["confirmed", "refuted"]), reason: z.string().min(1) }),
	),
});
const resultsSchema = z.object({
	results: z.array(z.object({ id: z.string().min(1), resolved: z.boolean(), evidence: z.string().min(1) })),
});

export type Verdict = z.infer<typeof verdictsSchema>["verdicts"][number];
export type ValidationResult = z.infer<typeof resultsSchema>["results"][number];

export type ParsedVerdicts = { ok: true; verdicts: Verdict[] } | { ok: false; error: string };
export type ParsedResults = { ok: true; results: ValidationResult[] } | { ok: false; error: string };

/** The refuter's reply. A finding it leaves out is the caller's to count as confirmed. */
export function parseVerdicts(text: string): ParsedVerdicts {
	const parsed = parseReply(text, verdictsSchema, "verdicts");
	return parsed.ok ? { ok: true, verdicts: parsed.value.verdicts } : parsed;
}

/** The validator's reply. A finding it leaves out is the caller's to count as unresolved. */
export function parseResults(text: string): ParsedResults {
	const parsed = parseReply(text, resultsSchema, "results");
	return parsed.ok ? { ok: true, results: parsed.value.results } : parsed;
}

function parseReply<T>(text: string, schema: z.ZodType<T>, key: string) {
	const json = extractJson(text);
	if (json === undefined) return { ok: false as const, error: `The reply has no JSON object with a ${key} list.` };
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		return { ok: false as const, error: `The reply is not valid JSON: ${describeError(error)}` };
	}
	const parsed = schema.safeParse(value);
	if (!parsed.success) return { ok: false as const, error: z.prettifyError(parsed.error) };
	// Two answers for one finding contradict each other or say nothing new: either way the reply is not trusted.
	const seen = new Set<string>();
	for (const entry of (parsed.data as Record<string, { id: string }[]>)[key] ?? []) {
		if (seen.has(entry.id)) return { ok: false as const, error: `The reply answers ${entry.id} more than once.` };
		seen.add(entry.id);
	}
	return { ok: true as const, value: parsed.data };
}

/** Same extraction as parseFindings: the last ```json block, else the whole text, else first `{` to last `}`. */
function extractJson(text: string): string | undefined {
	const fenced = [...text.matchAll(/```json[^\S\n]*\n([\s\S]*?)```/gi)].at(-1)?.[1];
	if (fenced !== undefined) return fenced.trim();
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) return trimmed;
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	return start !== -1 && end > start ? trimmed.slice(start, end + 1) : undefined;
}
