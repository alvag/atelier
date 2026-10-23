import { z } from "zod";
import { defineTool, type ToolDefinition, type ToolOutcome } from "../tools/types.ts";
import { type Escalation, LENSES, type Lens } from "./risk.ts";

export const RISK_TOOL = "risk";
export const REASON_LIMIT_BYTES = 500;

/** What the agent asked about the current change's risk; cleared once the change is reviewed or declined. */
export class RiskRequests {
	escalations: Escalation[] = [];
	lens: Lens | undefined;
	lensReason: string | undefined;
	/** The reason the agent gave for declaring the change not high-risk. */
	none: string | undefined;

	clear(): void {
		this.escalations = [];
		this.none = undefined;
		this.lens = undefined;
		this.lensReason = undefined;
	}
}

/** The agent's only say in the risk: declare high-risk items or none, each with a reason, or pick the lens of a medium-risk review. */
export function createRiskTool(state: RiskRequests): ToolDefinition {
	return defineTool({
		name: RISK_TOOL,
		description: [
			"Declares the risk of your current change; call it to close every code change. Name the high-risk items that apply with a reason (the change then gets a full review before it is reported done), or declare none with a reason. It can only raise the risk, never lower what the automatic check finds.",
			"Items: 1 stored data that cannot be rebuilt or irreversible effects (migrations, rewriting or deleting existing records; not saving new records, caches or generated files), 2 security, 3 contracts others consume, 4 concurrency, 5 delivery or environment, 6 no test would catch a regression.",
			"For a medium-risk change you can instead pick the one lens its review should use.",
		].join("\n"),
		inputShape: {
			items: z.array(z.number().int().min(1).max(6)).min(1).max(6).optional().describe("High-risk items that apply"),
			none: z.boolean().optional().describe("true to declare that no high-risk item applies; needs a reason"),
			reason: z.string().optional().describe(`Why, at most ${REASON_LIMIT_BYTES} bytes`),
			lenses: z.array(z.enum(LENSES)).length(1).optional().describe("The one lens for a medium-risk review"),
		},
		execute: async ({ items, none, reason, lenses }) => {
			const lens = lenses?.[0];
			const declaresNone = none === true;
			if (items === undefined && !declaresNone && lens === undefined)
				return fail("Give items with a reason, none with a reason, or a lens for a medium-risk review.");
			if (items !== undefined && declaresNone) return fail("Give items or none, not both.");
			if (items !== undefined && (reason === undefined || reason.trim() === ""))
				return fail("A reason is required with items.");
			if (declaresNone && (reason === undefined || reason.trim() === ""))
				return fail("A reason is required with none.");
			const bytes = Buffer.byteLength(reason ?? "", "utf8");
			if (bytes > REASON_LIMIT_BYTES) return fail(`The reason is ${bytes} bytes; the limit is ${REASON_LIMIT_BYTES}.`);

			const why = reason?.trim() || undefined;
			const lines: string[] = [];
			if (items !== undefined) {
				const unique = [...new Set(items)].sort((a, b) => a - b);
				state.escalations.push({ items: unique, reason: why as string });
				lines.push(
					`Risk raised to high: ${unique.length === 1 ? "item" : "items"} ${unique.join(", ")} (${why}). It applies until this change is reviewed or declined.`,
				);
			}
			if (declaresNone) {
				state.none = why;
				lines.push(
					`Risk declared none (${why}). It never lowers a risk Atelier finds, and applies until this change is reviewed or declined.`,
				);
			}
			if (lens !== undefined) {
				state.lens = lens;
				state.lensReason = why;
				lines.push(`Lens for a medium-risk review: ${lens}${why === undefined ? "" : ` (${why})`}.`);
			}
			return { ok: true, output: lines.join("\n"), summary: lines[0] as string, truncated: false };
		},
	});
}

function fail(output: string): ToolOutcome {
	return { ok: false, output, summary: output, truncated: false };
}
