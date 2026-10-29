import { type AtelierEvent, ClaudeCodeBackend, type QueryFunction, type SdkQuery, Session } from "@atelier/core";
import { describe, expect, it } from "vitest";
import { type FooterState, footerAfter, footerLine } from "../src/tui/footer.ts";
import { painter } from "../src/tui/style.ts";

const plain = painter(false);

const message = (value: Record<string, unknown>) => ({ uuid: "u", session_id: "s", ...value });

/** A main-thread answer whose request carried 18,000 tokens. */
const answer = message({
	type: "assistant",
	parent_tool_use_id: null,
	message: {
		role: "assistant",
		model: "claude-opus-5-5",
		content: [],
		usage: { input_tokens: 2, cache_read_input_tokens: 17_000, cache_creation_input_tokens: 998, output_tokens: 5 },
	},
});
const finished = message({
	type: "result",
	subtype: "success",
	is_error: false,
	stop_reason: "end_turn",
	total_cost_usd: 0.01,
	result: "",
	usage: { input_tokens: 2, output_tokens: 5, cache_read_input_tokens: 17_000, cache_creation_input_tokens: 998 },
	modelUsage: { "claude-opus-5-5[1m]": { contextWindow: 1_000_000, canonicalModel: "claude-opus-5-5" } },
});
const compacted = message({
	type: "system",
	subtype: "compact_boundary",
	compact_metadata: { trigger: "auto", pre_tokens: 18_000, post_tokens: 3000 },
});

/** Claude Code that plays one reply per prompt; `hang` waits until the query is closed, an Error crashes it. */
function claudeCode(replies: (Record<string, unknown> | Error | "hang")[][]): QueryFunction {
	return ({ prompt }) => {
		let closed: () => void = () => {};
		const closing = new Promise<void>((resolve) => {
			closed = resolve;
		});
		async function* run() {
			for await (const _ of prompt) {
				for (const item of replies.shift() ?? []) {
					if (item instanceof Error) throw item;
					if (item === "hang") {
						await closing;
						return;
					}
					yield item;
				}
			}
		}
		return Object.assign(run(), { interrupt: async () => {}, close: () => closed() }) as unknown as SdkQuery;
	};
}

async function footerAfterTurn(events: AsyncIterable<AtelierEvent>, state: FooterState): Promise<FooterState> {
	let next = state;
	for await (const event of events) next = footerAfter(next, event);
	return next;
}

describe("footer on claude-code", () => {
	it.each([
		["the interrupt does not finish in time", [compacted, "hang"] as const, true],
		["Claude Code crashes", [compacted, new Error("claude exited with code 1")] as const, false],
	])("says the size is unknown when a turn that compacted ends without its result: %s", async (_, reply, interrupt) => {
		const query = claudeCode([[answer, finished], [...reply]]);
		const session = await Session.start({
			backend: new ClaudeCodeBackend({ query, env: {}, interruptGraceMs: 10 }),
			cwd: "/w",
			tools: [],
		});
		let state = await footerAfterTurn(session.send("one"), {});
		expect(footerLine(state, 120, plain, ["context"])).toBe(" ctx 2%");
		const second = footerAfterTurn(session.send("two"), state);
		if (interrupt) await session.interrupt();
		state = await second;
		expect(footerLine(state, 120, plain, ["context"])).toBe(" ctx ?");
		await session.close();
	});
});
