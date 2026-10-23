import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { grepTool } from "./grep.ts";
import { readTool } from "./read.ts";
import type { ToolDefinition } from "./types.ts";

export { type BashOptions, bashTool, createBashTool, DEFAULT_TIMEOUT_SEC } from "./bash.ts";
export { editTool } from "./edit.ts";
export { createGrepTool, grepTool } from "./grep.ts";
export { PathOutsideError, resolveInside } from "./paths.ts";
export { readTool } from "./read.ts";
export * from "./types.ts";

/** The tools every M1 session gets. */
export const coreTools: readonly ToolDefinition[] = [readTool, editTool, bashTool, grepTool];
