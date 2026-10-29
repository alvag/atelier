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

/**
 * Claude Code that plays one reply per prompt; `hang` waits until the query is closed, then sends what follows it in
 * the reply and ends; an Error crashes it. A `dead` one ignores `close()`, so a turn left hanging never ends on its own.
 */
function claudeCode(replies: (Record<string, unknown> | Error | "hang")[][], dead = false): QueryFunction {
	return ({ prompt }) => {
		let closed: () => void = () => {};
		const closing = new Promise<void>((resolve) => {
			closed = resolve;
		});
		async function* run() {
			for await (const _ of prompt) {
				const reply = replies.shift() ?? [];
				for (const [index, item] of reply.entries()) {
					if (item instanceof Error) throw item;
					if (item === "hang") {
						await closing;
						yield* reply.slice(index + 1) as Record<string, unknown>[];
						return;
					}
					yield item;
				}
			}
		}
		const close = () => {
			if (!dead) closed();
		};
		return Object.assign(run(), { interrupt: async () => {}, close }) as unknown as SdkQuery;
	};
}

async function footerAfterTurn(events: AsyncIterable<AtelierEvent>, state: FooterState): Promise<FooterState> {
	let next = state;
	for await (const event of events) next = footerAfter(next, event);
	return next;
}

describe("footer on claude-code", () => {
	it.each([
		["the interrupt does not finish in time", [compacted, "hang"] as const, true, false],
		["the interrupt does not finish in time and the query ignores close", [compacted, "hang"] as const, true, true],
		["Claude Code crashes", [compacted, new Error("claude exited with code 1")] as const, false, false],
	])(
		"says the size is unknown when a turn that compacted ends without its result: %s",
		async (_, reply, interrupt, dead) => {
			const query = claudeCode([[answer, finished], [...reply]], dead);
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
			// The session is over: the next turn says so instead of waiting on Claude Code.
			const third: AtelierEvent[] = [];
			for await (const event of session.send("three")) third.push(event);
			expect(third.map((event) => event.type)).toEqual(["error", "turn_finished"]);
			await session.close();
		},
	);

	it("never takes a result Claude Code sends after the interrupt timed out for the next turn", async () => {
		let results = 0;
		const backend = new ClaudeCodeBackend({
			query: claudeCode([
				[answer, finished],
				[compacted, "hang", finished],
			]),
			env: {},
			interruptGraceMs: 10,
			onSdkMessage: (sdk) => {
				if (sdk.type === "result") results++;
			},
		});
		const session = await Session.start({ backend, cwd: "/w", tools: [] });
		await footerAfterTurn(session.send("one"), {});
		const second = footerAfterTurn(session.send("two"), {});
		await session.interrupt();
		await second;
		while (results < 2) await new Promise((resolve) => setImmediate(resolve));
		const third: AtelierEvent[] = [];
		for await (const event of session.send("three")) third.push(event);
		expect(third.map((event) => (event.type === "turn_finished" ? event.stopReason : event.type))).toEqual([
			"error",
			"error",
		]);
		await session.close();
	});
});
