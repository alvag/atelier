import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { openGrepTool } from "./grep.ts";
import { openReadTool } from "./read.ts";
import type { ToolDefinition } from "./types.ts";

export { type BashOptions, bashTool, createBashTool, DEFAULT_TIMEOUT_SEC } from "./bash.ts";
export { createEditTool, type EditOptions, editTool } from "./edit.ts";
export { createGrepTool, grepTool, openGrepTool } from "./grep.ts";
export { PathOutsideError, PathProtectedError, resolveInside } from "./paths.ts";
export { createReadTool, openReadTool, readTool } from "./read.ts";
export {
	SANDBOX_MECHANISM,
	SANDBOX_OFF,
	Sandbox,
	type SandboxManagerLike,
	type SandboxPolicyName,
	type SandboxStatus,
	type SandboxViolation,
	sandbox,
	sandboxEnabled,
} from "./sandbox.ts";
export {
	loadSandboxAdditions,
	projectConfigFile,
	type SandboxAdditions,
	SandboxConfigError,
	userConfigFile,
} from "./sandbox-config.ts";
export * from "./types.ts";

/** The tools every M1 session gets: `read` and `grep` may leave the working directory, `edit` may with the user's approval. */
export const coreTools: readonly ToolDefinition[] = [openReadTool, editTool, bashTool, openGrepTool];
