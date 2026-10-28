import { afterEach, expect, it } from "vitest";
import { codexContextWindow, codexReasoning } from "../src/backends/openai-codex/models.ts";
import { openCodeGoModel } from "../src/backends/opencode-go/models.ts";
import { ModelData, useModelData } from "../src/model-catalog/index.ts";
import { costOfRequest, thinkingToSend } from "../src/pricing.ts";

const USAGE = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 };

afterEach(() => useModelData(new ModelData()));

const catalog = new ModelData({
	"anthropic-api": [
		{ id: "claude-new-6", prices: [{ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }], efforts: ["low", "high"] },
		// The code's tables know these: what the catalog says of them is not used.
		{ id: "claude-sonnet-4-6", efforts: ["low", "xhigh"], off: "disabled" },
		{ id: "claude-off-6", off: "between_tools" },
		{ id: "claude-opus-5-5", prices: [{ input: 100, output: 100, cacheRead: 0, cacheWrite: 0 }] },
	],
	"opencode-go": [
		{
			id: "grok-4.7",
			contextWindow: 500_000,
			prices: [{ input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 }],
			efforts: ["low", "high"],
			off: "disabled",
		},
		{ id: "bare-model" },
		{ id: "minimax-m3", contextWindow: 10 },
	],
	"claude-code": [
		{ id: "claude-fable-5-2", efforts: ["low", "max"] },
		{ id: "opus", efforts: ["low"] },
	],
	"openai-codex": [
		{ id: "gpt-6.1-terra", contextWindow: 400_000, efforts: ["low", "high"] },
		{ id: "gpt-6-sol", contextWindow: 10, efforts: ["low"] },
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
	// Thinking is turned off as the catalog says the model takes it, and not where it says nothing.
	expect(thinkingToSend("claude-new-6", "off", "anthropic-api")).toEqual({ report: "unsupported" });
	expect(thinkingToSend("claude-off-6", "off", "anthropic-api")).toEqual({ report: "off", thinking: "between_tools" });
	expect(thinkingToSend("claude-sonnet-4-6", "xhigh", "anthropic-api")).toEqual({ report: "unsupported" });
	expect(thinkingToSend("claude-sonnet-4-6", "off", "anthropic-api")).toEqual({ report: "unsupported" });

	expect(thinkingToSend("grok-4.7", "minimal", "opencode-go")).toEqual({ report: "low", effort: "low" });
	expect(thinkingToSend("grok-4.7", "off", "opencode-go")).toEqual({ report: "off", thinking: "disabled" });
	expect(thinkingToSend("bare-model", "high", "opencode-go")).toEqual({ report: "unsupported" });
	expect(thinkingToSend("bare-model", "off", "opencode-go")).toEqual({ report: "unsupported" });
});

it("sends Claude Code the levels the catalog gives a model its tables lack, and the tables' for an alias", () => {
	expect(thinkingToSend("claude-fable-5-2", "max", "claude-code")).toEqual({ report: "unsupported" });
	useModelData(catalog);
	expect(thinkingToSend("claude-fable-5-2", "max", "claude-code")).toEqual({ report: "max", effort: "max" });
	expect(thinkingToSend("claude-fable-5-2", "high", "claude-code")).toEqual({ report: "unsupported" });
	expect(thinkingToSend("opus", "high", "claude-code")).toEqual({ report: "high", effort: "high" });
});

it("gives a Codex model the catalog doesn't know Codex's window and levels; the ones it knows keep the code's", () => {
	expect(codexContextWindow("gpt-6.1-terra")).toBe(272_000);
	expect(codexReasoning("gpt-6.1-terra", "max")).toEqual({ report: "max", effort: "max" });
	useModelData(catalog);
	expect(codexContextWindow("gpt-6.1-terra")).toBe(400_000);
	expect(codexReasoning("gpt-6.1-terra", "max")).toEqual({ report: "unsupported" });
	expect(codexReasoning("gpt-6.1-terra", "minimal")).toEqual({ report: "low", effort: "low" });
	expect(codexReasoning("gpt-6.1-terra", "off")).toEqual({ report: "off", effort: "none" });
	expect(codexContextWindow("gpt-6-sol")).toBe(272_000);
	expect(codexReasoning("gpt-6-sol", "max")).toEqual({ report: "max", effort: "max" });
	expect(codexContextWindow("unknown-model")).toBe(272_000);
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
