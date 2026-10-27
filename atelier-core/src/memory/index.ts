/** The memory module: the interface, and the one adapter that implements it. */
export { connectEngram as connectMemory, ENGRAM_MIN_VERSION as MEMORY_MIN_VERSION } from "./engram.ts";
export * from "./port.ts";
export { recoveryNotice, type SummaryOutcome } from "./recovery.ts";
export { memoryPromptsEnabled } from "./settings.ts";
export {
	CONTEXT_BYTES,
	createMemoryTool,
	findSecret,
	MEMORY_TOOL,
	maskSecrets,
	PROMPT_CHARS,
	promptForMemory,
} from "./tool.ts";
