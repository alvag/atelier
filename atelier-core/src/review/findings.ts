import { z } from "zod";
import { describeError } from "../events.ts";
import { LENSES, type Lens } from "./risk.ts";

const SEVERITIES = ["blocker", "critical", "major", "minor"] as const;
const CAUSES = ["candidate", "pre-existing", "unknown"] as const;

export const findingSchema = z.object({
	id: z.string().min(1),
	lens: z.enum(LENSES),
	severity: z.enum(SEVERITIES),
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

	const counts = new Map<Lens, number>();
	const findings = parsed.data.findings.map((found) => {
		const owner = lens ?? found.lens;
		const next = (counts.get(owner) ?? 0) + 1;
		counts.set(owner, next);
		return { ...found, lens: owner, id: `${ID_PREFIX[owner]}-${String(next).padStart(3, "0")}` };
	});
	return { ok: true, findings };
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
