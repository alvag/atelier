import { z } from "zod";
import { defineTool, type ToolDefinition, type ToolOutcome } from "../tools/types.ts";
import { type Escalation, LENSES, type Lens } from "./risk.ts";

export const RISK_TOOL = "risk";
export const REASON_LIMIT_BYTES = 500;

/** What the agent asked about the current change's risk; cleared once the change is reviewed or declined. */
export class RiskRequests {
	escalations: Escalation[] = [];
	/** The lenses the agent chose for the review, and why. */
	lenses: Lens[] | undefined;
	lensesReason: string | undefined;
	/** The candidate tree its turn assessed with those lenses: a review of another tree does not take them. */
	tree: string | undefined;
	/** The reason the agent gave for declaring the change not high-risk. */
	none: string | undefined;

	clear(): void {
		this.escalations = [];
		this.none = undefined;
		this.lenses = undefined;
		this.lensesReason = undefined;
		this.tree = undefined;
	}
}

/** The agent's only say in the risk: declare high-risk items or none, each with a reason, and pick the lenses of the review. */
export function createRiskTool(state: RiskRequests): ToolDefinition {
	return defineTool({
		name: RISK_TOOL,
		description: [
			"Declares the risk of your current change; call it to close every code change. Name the high-risk items that apply with a reason (the change then gets a full review before it is reported done), or declare none with a reason. It can only raise the risk, never lower what the automatic check finds.",
			"Items: 1 stored data that cannot be rebuilt or irreversible effects (migrations, rewriting or deleting existing records; not saving new records, caches or generated files), 2 security, 3 contracts others consume, 4 concurrency (asynchronous events or callbacks that can arrive in another order, turn or request than expected, interrupts and timeouts, races, shared mutable state, locks), 5 delivery or environment, 6 no test would catch a regression.",
			"Pick the review's lenses (1 to 4) with a lensesReason naming what you touched and how, as your instructions describe; without them a high-risk review uses all four. A high risk Atelier finds by itself always keeps the risk lens.",
		].join("\n"),
		inputShape: {
			items: z.array(z.number().int().min(1).max(6)).min(1).max(6).optional().describe("High-risk items that apply"),
			none: z.boolean().optional().describe("true to declare that no high-risk item applies; needs a reason"),
			reason: z.string().optional().describe(`Why the items or none, at most ${REASON_LIMIT_BYTES} bytes`),
			lenses: z
				.array(z.enum(LENSES))
				.min(1)
				.max(4)
				.optional()
				.describe("The lenses of the review; needs a lensesReason"),
			lensesReason: z.string().optional().describe(`What you touched and how, at most ${REASON_LIMIT_BYTES} bytes`),
		},
		execute: async ({ items, none, reason, lenses, lensesReason }) => {
			const declaresNone = none === true;
			if (items === undefined && !declaresNone && lenses === undefined && lensesReason === undefined)
				return fail("Give items with a reason, none with a reason, or lenses with a lensesReason.");
			if (items !== undefined && declaresNone) return fail("Give items or none, not both.");
			if (items !== undefined && blank(reason)) return fail("A reason is required with items.");
			if (declaresNone && blank(reason)) return fail("A reason is required with none.");
			if (lenses === undefined && lensesReason !== undefined) return fail("A lensesReason needs lenses.");
			if (lenses !== undefined && blank(lensesReason)) return fail("A lensesReason is required with lenses.");
			if (reason !== undefined && items === undefined && !declaresNone)
				return fail("A reason goes with items or none; give the lenses' reason as lensesReason.");
			if (lenses !== undefined && new Set(lenses).size !== lenses.length) return fail("Each lens can be chosen once.");
			const tooLong = overLimit("reason", reason) ?? overLimit("lensesReason", lensesReason);
			if (tooLong !== undefined) return fail(tooLong);

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
			if (lenses !== undefined) {
				const chosen = (lensesReason as string).trim();
				state.lenses = [...lenses];
				state.lensesReason = chosen;
				lines.push(`Lenses for the review: ${lenses.join(", ")} (${chosen}).`);
			}
			return { ok: true, output: lines.join("\n"), summary: lines[0] as string, truncated: false };
		},
	});
}

function blank(text: string | undefined): boolean {
	return text === undefined || text.trim() === "";
}

function overLimit(name: string, text: string | undefined): string | undefined {
	const bytes = Buffer.byteLength(text ?? "", "utf8");
	return bytes > REASON_LIMIT_BYTES ? `The ${name} is ${bytes} bytes; the limit is ${REASON_LIMIT_BYTES}.` : undefined;
}

function fail(output: string): ToolOutcome {
	return { ok: false, output, summary: output, truncated: false };
}
