import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { openGrepTool } from "./grep.ts";
import { openReadTool } from "./read.ts";
import type { ToolDefinition } from "./types.ts";
import { webFetchTool } from "./web-fetch.ts";
import { webSearchTool } from "./web-search.ts";
import { writeTool } from "./write.ts";

export {
	ASK_USER_TOOL,
	type AskUser,
	createAskUserTool,
	parseUserAnswers,
	type UserAnswer,
	type UserQuestion,
	type UserQuestionResult,
} from "./ask-user.ts";
export {
	BASH_BACKGROUND_TOOL,
	createBackgroundTools,
	JOB_LIST_TOOL,
	JOB_STOP_TOOL,
} from "./background.ts";
export { type BashOptions, bashTool, createBashTool, DEFAULT_TIMEOUT_SEC } from "./bash.ts";
export {
	type CommandRules,
	commandRuleScope,
	commandRules,
	coveredBy,
	isValidCommandRule,
} from "./command-rules.ts";
export { createEditTool, type EditOptions, editTool } from "./edit.ts";
export { createGrepTool, grepTool, openGrepTool } from "./grep.ts";
export { type EndedJob, type JobInfo, Jobs, MAX_RUNNING_JOBS } from "./jobs.ts";
export { MAX_WRITE_BYTES } from "./limits.ts";
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
export { createWebFetchTool, webFetchTool } from "./web-fetch.ts";
export { createWebSearchTool, webSearchTool } from "./web-search.ts";
export { createWriteTool, type WriteOptions, writeTool } from "./write.ts";

/** The tools every M1 session gets: `read` and `grep` may leave the working directory, `edit` and `write` may with the user's approval; `web_fetch` and `web_search` never ask. */
export const coreTools: readonly ToolDefinition[] = [
	openReadTool,
	editTool,
	writeTool,
	bashTool,
	openGrepTool,
	webFetchTool,
	webSearchTool,
];
