import { afterEach, expect, it } from "vitest";
import { openCodeGoModel } from "../src/backends/opencode-go/models.ts";
import { ModelData, useModelData } from "../src/model-catalog/index.ts";
import { costOfRequest, thinkingToSend } from "../src/pricing.ts";

const USAGE = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };

afterEach(() => useModelData(new ModelData()));

const catalog = new ModelData({
	"anthropic-api": [
		{ id: "claude-new-6", prices: [{ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }], efforts: ["low", "high"] },
		// The code's tables know these: what the catalog says of them is not used.
		{ id: "claude-sonnet-4-6", efforts: ["low", "xhigh"] },
		{ id: "claude-opus-5-5", prices: [{ input: 100, output: 100, cacheRead: 0, cacheWrite: 0 }] },
	],
	"opencode-go": [
		{
			id: "grok-4.7",
			contextWindow: 500_000,
			prices: [{ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }],
			efforts: ["low", "high"],
			off: true,
		},
		{ id: "bare-model" },
		{ id: "minimax-m3", contextWindow: 10 },
	],
});

it("prices a model only the catalog knows, and keeps the code's prices for the ones it knows", () => {
	expect(costOfRequest("claude-new-6", USAGE)).toBeUndefined();
	useModelData(catalog);
	expect(costOfRequest("claude-new-6", USAGE)).toBe(24);
	expect(costOfRequest("grok-4.7", USAGE)).toBe(8);
	expect(costOfRequest("claude-opus-5-5", USAGE)).toBe(24);
	expect(costOfRequest("bare-model", USAGE)).toBeUndefined();
});

it("sends the levels the catalog gives a model the code does not know, and only those", () => {
	expect(thinkingToSend("claude-new-6", "high", "anthropic-api")).toEqual({ report: "unsupported" });
	useModelData(catalog);
	expect(thinkingToSend("claude-new-6", "high", "anthropic-api")).toEqual({ report: "high", effort: "high" });
	expect(thinkingToSend("claude-new-6", "max", "anthropic-api")).toEqual({ report: "unsupported" });
	// Anthropic's ways to turn thinking off differ by model: the catalog does not say which, so it is not sent.
	expect(thinkingToSend("claude-new-6", "off", "anthropic-api")).toEqual({ report: "unsupported" });
	expect(thinkingToSend("claude-sonnet-4-6", "xhigh", "anthropic-api")).toEqual({ report: "unsupported" });

	expect(thinkingToSend("grok-4.7", "minimal", "opencode-go")).toEqual({ report: "low", effort: "low" });
	expect(thinkingToSend("grok-4.7", "off", "opencode-go")).toEqual({ report: "off", thinking: "disabled" });
	expect(thinkingToSend("bare-model", "high", "opencode-go")).toEqual({ report: "unsupported" });
	expect(thinkingToSend("bare-model", "off", "opencode-go")).toEqual({ report: "unsupported" });
});

it("gives an OpenCode Go model the catalog's window, through Chat Completions, and the table's to the ones it has", () => {
	expect(openCodeGoModel("grok-4.7").contextWindow).toBe(200_000);
	useModelData(catalog);
	expect(openCodeGoModel("grok-4.7")).toEqual({
		protocol: "openai-completions",
		contextWindow: 500_000,
		efforts: ["low", "high"],
		off: "none",
		prices: [{ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }],
	});
	expect(openCodeGoModel("bare-model")).toEqual({
		protocol: "openai-completions",
		contextWindow: 200_000,
		efforts: [],
	});
	expect(openCodeGoModel("minimax-m3").contextWindow).toBe(1_000_000);
});
