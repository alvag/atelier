import { z } from "zod";
import { defineTool, type ToolDefinition, type ToolOutcome } from "../tools/types.ts";
import { type Escalation, LENSES, type Lens } from "./risk.ts";

export const RISK_TOOL = "risk";
export const REASON_LIMIT_BYTES = 500;

/** What the agent asked about the current change's risk; cleared once the change is reviewed or declined. */
export class RiskRequests {
	escalations: Escalation[] = [];
	lens: Lens | undefined;

	clear(): void {
		this.escalations = [];
		this.lens = undefined;
	}
}

/** The agent's only say in the risk: raise it to high with a reason, or pick the lens of a medium-risk review. */
export function createRiskTool(state: RiskRequests): ToolDefinition {
	return defineTool({
		name: RISK_TOOL,
		description: [
			"Raises the risk of your current, uncommitted change when the automatic check cannot see it, so it gets a full review before it is reported done. It can only raise the risk, never lower it.",
			"Items: 1 data or irreversible effects, 2 security, 3 contracts others consume, 4 concurrency, 5 delivery or environment, 6 no test would catch a regression.",
			"For a medium-risk change you can instead pick the one lens its review should use.",
		].join("\n"),
		inputShape: {
			items: z.array(z.number().int().min(1).max(6)).min(1).max(6).optional().describe("High-risk items that apply"),
			reason: z.string().optional().describe(`Why, at most ${REASON_LIMIT_BYTES} bytes`),
			lens: z.enum(LENSES).optional().describe("The lens for a medium-risk review"),
		},
		execute: async ({ items, reason, lens }) => {
			if (items === undefined && lens === undefined)
				return fail("Give items with a reason to raise the risk, or a lens for a medium-risk review.");
			if (items !== undefined && (reason === undefined || reason.trim() === ""))
				return fail("A reason is required with items.");
			const bytes = Buffer.byteLength(reason ?? "", "utf8");
			if (bytes > REASON_LIMIT_BYTES) return fail(`The reason is ${bytes} bytes; the limit is ${REASON_LIMIT_BYTES}.`);

			const lines: string[] = [];
			if (items !== undefined) {
				const unique = [...new Set(items)].sort((a, b) => a - b);
				state.escalations.push({ items: unique, reason: (reason as string).trim() });
				lines.push(
					`Risk raised to high: ${unique.length === 1 ? "item" : "items"} ${unique.join(", ")} (${(reason as string).trim()}). It applies until this change is reviewed or declined.`,
				);
			}
			if (lens !== undefined) {
				state.lens = lens;
				lines.push(`Lens for a medium-risk review: ${lens}.`);
			}
			return { ok: true, output: lines.join("\n"), summary: lines[0] as string, truncated: false };
		},
	});
}

function fail(output: string): ToolOutcome {
	return { ok: false, output, summary: output, truncated: false };
}
