export const VERSION = "0.0.0";

export type {
	AgentBackend,
	BackendSession,
	BackendStartOptions,
	ToolCall,
	ToolCallResult,
	ToolExecutor,
} from "./backend.ts";
export * from "./events.ts";
export { FakeBackend, type FakeStep } from "./fake-backend.ts";
export { type ApprovalRequest, Session, type SessionOptions } from "./session.ts";
export * from "./tools/index.ts";
