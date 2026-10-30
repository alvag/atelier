import { z } from "zod";
import { describeError } from "../events.ts";
import { LENSES, type Lens } from "./risk.ts";

const SEVERITIES = ["blocker", "critical", "warning", "suggestion"] as const;
const CAUSES = ["candidate", "pre-existing", "unknown"] as const;

/**
 * The severity criterion, copied from gentle-ai (`reviewerprovider/contract.go`),
 * that the lenses and the refuter both apply. Severities are lowercase here
 * because they are the values of the JSON the lenses answer.
 */
export const SEVERITY_CRITERION = [
	"A blocker or critical finding must be caused by this change (the behavior does not already happen on the base) and reachable with realistic input.",
	"A blocker or critical finding must name its observable harm: violating what was requested, or breaking something that worked before.",
	"Silently ignoring an explicit option or argument while reporting success, or changing an existing output nobody asked to change, is also severe.",
	"What already happened on the base and was not asked to change, what needs out-of-range values, and what falls outside the scope of the request without violating anything are at most warning.",
].join(" ");

/** Replies and receipts written before the four levels used major and minor: they read as warning and suggestion. */
const LEGACY_SEVERITIES = { major: "warning", minor: "suggestion" } as const;

const severitySchema = z.preprocess(
	(value) =>
		typeof value === "string" && value in LEGACY_SEVERITIES
			? LEGACY_SEVERITIES[value as keyof typeof LEGACY_SEVERITIES]
			: value,
	z.enum(SEVERITIES),
);

export const findingSchema = z.object({
	id: z.string().min(1),
	lens: z.enum(LENSES),
	severity: severitySchema,
	cause: z.enum(CAUSES),
	path: z.string().min(1),
	line: z.number().int().min(1).optional(),
	claim: z.string().min(1),
	evidence: z.string().min(1),
});
const reportSchema = z.object({ findings: z.array(findingSchema) });

export type Finding = z.infer<typeof findingSchema>;

export type ParsedFindings = { ok: true; findings: Finding[] } | { ok: false; error: string };

/** Id prefixes: two lenses never share one, so ids from different lenses cannot collide. */
const ID_PREFIX: Record<Lens, string> = { risk: "RK", resilience: "RS", readability: "RD", reliability: "RL" };

/** Only a blocker or critical finding caused by the candidate stops the review; the rest are follow-ups or go to the refuter. */
export function isBlocking(finding: Finding): boolean {
	return (finding.severity === "blocker" || finding.severity === "critical") && finding.cause === "candidate";
}

/**
 * Reads a lens's final message: the last ```json fenced block, else the whole
 * text as JSON, else the span from the first `{` to the last `}`. Ids the model
 * chose are discarded: each finding gets `<lens prefix>-<n>` (RK-001, RS-002...),
 * numbered per lens in order, so ids are unique across the lenses of a review.
 * When `lens` is given it is the lens that ran, and overrides what the model wrote.
 */
export function parseFindings(text: string, lens?: Lens): ParsedFindings {
	const json = extractJson(text);
	if (json === undefined) return { ok: false, error: "The reply has no JSON object with a findings list." };
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		return { ok: false, error: `The reply is not valid JSON: ${describeError(error)}` };
	}
	const parsed = reportSchema.safeParse(value);
	if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };

	return { ok: true, findings: numberFindings(parsed.data.findings, lens) };
}

/**
 * Gives each finding the id `<lens prefix>-<n>`, numbered per lens in order; `lens`, when given, overrides
 * the lens each one names. A lens that ran over several parts of a change is numbered again once joined.
 */
export function numberFindings(findings: readonly Finding[], lens?: Lens): Finding[] {
	const counts = new Map<Lens, number>();
	return findings.map((found) => {
		const owner = lens ?? found.lens;
		const next = (counts.get(owner) ?? 0) + 1;
		counts.set(owner, next);
		return { ...found, lens: owner, id: `${ID_PREFIX[owner]}-${String(next).padStart(3, "0")}` };
	});
}

function extractJson(text: string): string | undefined {
	const fenced = [...text.matchAll(/```json[^\S\n]*\n([\s\S]*?)```/gi)].at(-1)?.[1];
	if (fenced !== undefined) return fenced.trim();
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) return trimmed;
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	return start !== -1 && end > start ? trimmed.slice(start, end + 1) : undefined;
}
