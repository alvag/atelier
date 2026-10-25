import { describe, expect, it } from "vitest";
import { toAnthropicTools } from "../src/backends/anthropic-api/tool-schema.ts";
import { cacheHitRate } from "../src/events.ts";
import { costOfRequest, PRICES, thinkingToSend } from "../src/pricing.ts";
import { coreTools } from "../src/tools/index.ts";
import { UsageMeter } from "../src/usage-meter.ts";

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
});

describe("toAnthropicTools", () => {
	it("keeps the core tool order and emits object schemas without $schema", () => {
		const tools = toAnthropicTools(coreTools);
		expect(tools.map((tool) => tool.name)).toEqual(["read", "edit", "write", "bash", "grep"]);
		for (const tool of tools) {
			expect(tool.description?.length).toBeGreaterThan(0);
			expect(tool.input_schema.type).toBe("object");
			expect(tool.input_schema).not.toHaveProperty("$schema");
		}
		const bash = tools.find((tool) => tool.name === "bash");
		expect(bash?.input_schema.required).toContain("command");
	});

	it("produces the same bytes every time, so the cached prefix stays stable", () => {
		expect(JSON.stringify(toAnthropicTools(coreTools))).toBe(JSON.stringify(toAnthropicTools(coreTools)));
	});
});

describe("costOfRequest", () => {
	it("prices Sonnet 5.5 input, output, cache writes and cache reads per million tokens", () => {
		// $2 input, $10 output, $2.50 5-minute write, $0.10 read.
		const cost = costOfRequest("claude-sonnet-5-5", usage(1_000_000, 1_000_000, 1_000_000, 1_000_000));
		expect(cost).toBeCloseTo(2 + 10 + 0.1 + 2.5, 10);
	});

	it("prices Opus 5.5", () => {
		expect(costOfRequest("claude-opus-5-5", usage(1_000_000, 1_000_000, 1_000_000, 1_000_000))).toBeCloseTo(
			4 + 20 + 0.2 + 5,
			10,
		);
	});

	it("uses the higher Haiku 5.5 tier once the prompt, cache included, passes 100,000 tokens", () => {
		expect(costOfRequest("claude-haiku-5-5", usage(100_000, 0))).toBeCloseTo(0.01, 10);
		expect(costOfRequest("claude-haiku-5-5", usage(50_000, 0, 40_000, 10_001))).toBeCloseTo(
			(50_000 * 0.5 + 40_000 * 0.05 + 10_001 * 0.625) / 1_000_000,
			10,
		);
	});

	it("returns undefined for a model missing from the table instead of inventing a cost", () => {
		expect(costOfRequest("claude-unknown-9", usage(10, 10))).toBeUndefined();
	});

	it("lists only models it can price", () => {
		expect(Object.keys(PRICES).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
	});
});

describe("cacheHitRate", () => {
	it("divides cache reads by every input token, cache writes included", () => {
		expect(cacheHitRate(usage(100, 50, 800, 100))).toBeCloseTo(0.8, 10);
	});

	it("is undefined when there was no input at all", () => {
		expect(cacheHitRate(usage(0, 0))).toBeUndefined();
	});

	it("is 1 when every input token came from the cache", () => {
		expect(cacheHitRate(usage(0, 5, 1000, 0))).toBe(1);
	});
});

describe("UsageMeter", () => {
	it("starts empty", () => {
		const meter = new UsageMeter("claude-sonnet-5-5");
		expect(meter.requests).toBe(0);
		expect(meter.usage).toEqual(usage(0, 0));
		expect(meter.costUsd).toBe(0);
	});

	it("sums the requests of a turn and prices each request on its own", () => {
		const meter = new UsageMeter("claude-haiku-5-5");
		meter.add(usage(100_000, 0));
		meter.add(usage(150_000, 0));
		expect(meter.requests).toBe(2);
		expect(meter.usage).toEqual(usage(250_000, 0));
		// The first request stays in the low tier; pricing the sum would put both in the high one.
		expect(meter.costUsd).toBeCloseTo((100_000 * 0.1 + 150_000 * 0.5) / 1_000_000, 10);
	});

	it("reports no cost for an unknown model but still counts tokens", () => {
		const meter = new UsageMeter("claude-unknown-9");
		meter.add(usage(10, 20, 30, 40));
		expect(meter.usage).toEqual(usage(10, 20, 30, 40));
		expect(meter.costUsd).toBeUndefined();
	});

	it("does not let callers mutate its totals", () => {
		const meter = new UsageMeter("claude-sonnet-5-5");
		meter.add(usage(1, 1));
		meter.usage.input = 999;
		expect(meter.usage.input).toBe(1);
	});
});

describe("thinkingToSend", () => {
	const api = (model: string, level: Parameters<typeof thinkingToSend>[1]) =>
		thinkingToSend(model, level, "anthropic-api");
	const code = (model: string, level: Parameters<typeof thinkingToSend>[1]) =>
		thinkingToSend(model, level, "claude-code");

	it("sends the effort only to models that support it, by id or by Claude Code alias", () => {
		expect(api("claude-opus-5-5", "max")).toEqual({ report: "max", effort: "max" });
		expect(code("sonnet", "low")).toEqual({ report: "low", effort: "low" });
		expect(api("claude-haiku-5-5", "low")).toEqual({ report: "low", effort: "low" });
		expect(code("haiku", "xhigh")).toEqual({ report: "xhigh", effort: "xhigh" });
		expect(api("claude-fable-5-1", "max")).toEqual({ report: "max", effort: "max" });
		expect(api("a-model-atelier-does-not-know", "high")).toEqual({ report: "unsupported" });
		expect(api("claude-opus-5-5", undefined)).toBeUndefined();
	});

	it("sends only the levels each model takes", () => {
		expect(api("claude-opus-4-6", "max")).toEqual({ report: "max", effort: "max" });
		expect(api("claude-opus-4-6", "xhigh")).toEqual({ report: "unsupported" });
		expect(api("claude-sonnet-4-6", "xhigh")).toEqual({ report: "unsupported" });
		expect(api("claude-opus-4-5", "high")).toEqual({ report: "high", effort: "high" });
		expect(api("claude-opus-4-5-20251101", "max")).toEqual({ report: "unsupported" });
		expect(api("claude-haiku-4-5", "low")).toEqual({ report: "unsupported" });
	});

	it("sends minimal as low, as pi does", () => {
		expect(api("claude-opus-5-5", "minimal")).toEqual({ report: "low", effort: "low" });
		expect(api("claude-opus-4-5-20251101", "minimal")).toEqual({ report: "low", effort: "low" });
		expect(api("claude-haiku-4-5", "minimal")).toEqual({ report: "unsupported" });
	});

	it("turns thinking off with disabled on Haiku 5.5 and Opus 5, in both backends", () => {
		for (const backend of ["anthropic-api", "claude-code"] as const) {
			expect(thinkingToSend("claude-haiku-5-5", "off", backend)).toEqual({ report: "off", thinking: "disabled" });
			expect(thinkingToSend("haiku", "off", backend)).toEqual({ report: "off", thinking: "disabled" });
			expect(thinkingToSend("claude-opus-5", "off", backend)).toEqual({ report: "off", thinking: "disabled" });
		}
	});

	it("turns thinking off on Sonnet 5.5 with between_tools, which only the API takes", () => {
		expect(api("claude-sonnet-5-5", "off")).toEqual({ report: "off", thinking: "between_tools" });
		expect(api("sonnet", "off")).toEqual({ report: "off", thinking: "between_tools" });
		expect(code("claude-sonnet-5-5", "off")).toEqual({ report: "unsupported" });
		expect(code("sonnet", "off")).toEqual({ report: "unsupported" });
	});

	it("does not turn thinking off where the docs do not say how", () => {
		expect(api("claude-opus-5-5", "off")).toEqual({ report: "unsupported" });
		expect(code("opus", "off")).toEqual({ report: "unsupported" });
		expect(api("claude-opus-4-6", "off")).toEqual({ report: "unsupported" });
		expect(api("a-model-atelier-does-not-know", "off")).toEqual({ report: "unsupported" });
	});
});
