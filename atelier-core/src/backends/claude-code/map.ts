import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AtelierEventBody, Usage } from "../../events.ts";

export const BACKEND_ID = "claude-code";
export const MCP_SERVER_NAME = "atelier";

export interface MapContext {
	/** Running cost reported by the previous result; the SDK reports a cumulative total. */
	previousCostUsd: number;
}

const RECOVERABLE_API_ERRORS = new Set(["rate_limit", "overloaded", "server_error"]);

interface SdkUsage {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
}

function toUsage(usage: SdkUsage | undefined): Usage {
	return {
		input: usage?.input_tokens ?? 0,
		output: usage?.output_tokens ?? 0,
		cacheRead: usage?.cache_read_input_tokens ?? 0,
		cacheWrite: usage?.cache_creation_input_tokens ?? 0,
	};
}

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

/**
 * Translates one Claude Agent SDK message into Atelier events. Pure: the
 * caller keeps the running cost in `context`. Text and thinking come only from
 * stream events; tool calls are reported by the core when it executes them.
 */
export function mapSdkMessage(message: SDKMessage, context: MapContext): AtelierEventBody[] {
	switch (message.type) {
		case "system": {
			if (message.subtype !== "init") return [];
			const events: AtelierEventBody[] = [
				{
					type: "session_started",
					backend: BACKEND_ID,
					model: message.model,
					// "none" only means no API key; the backend confirms a subscription with accountInfo().
					authSource: message.apiKeySource === "none" ? "other" : "api_key",
				},
			];
			const server = message.mcp_servers?.find((s) => s.name === MCP_SERVER_NAME);
			if (server?.status !== "connected") {
				events.push({
					type: "error",
					code: "tools_unavailable",
					message: `Atelier tools are not available to Claude Code (MCP server status: ${server?.status ?? "missing"}).`,
					recoverable: false,
				});
			}
			return events;
		}

		case "stream_event": {
			if (message.parent_tool_use_id !== null) return [];
			const event = message.event;
			if (event.type !== "content_block_delta") return [];
			if (event.delta.type === "text_delta") return [{ type: "text_delta", text: event.delta.text }];
			if (event.delta.type === "thinking_delta") return [{ type: "thinking_delta", text: event.delta.thinking }];
			return [];
		}

		case "assistant": {
			if (message.parent_tool_use_id !== null || message.error === undefined) return [];
			if (message.error === "authentication_failed") {
				return [
					{
						type: "error",
						code: "not_logged_in",
						message: "Claude Code is not logged in. Run `claude`, use /login, and try again.",
						recoverable: false,
					},
				];
			}
			return [
				{
					type: "error",
					code: `api_${message.error}`,
					message: textOf(message.message?.content) || message.error,
					recoverable: RECOVERABLE_API_ERRORS.has(message.error),
				},
			];
		}

		case "rate_limit_event": {
			const info = message.rate_limit_info;
			return [
				{
					type: "rate_limit",
					status: info.status,
					...(info.resetsAt === undefined ? {} : { resetsAt: info.resetsAt }),
					...(info.rateLimitType === undefined ? {} : { window: info.rateLimitType }),
				},
			];
		}

		case "result": {
			const costUsd = Math.max(0, message.total_cost_usd - context.previousCostUsd);
			const usage = toUsage(message.usage);
			// num_turns counts this turn's model requests (one per assistant message), not the session's.
			const requests = typeof message.num_turns === "number" ? { requests: message.num_turns } : {};
			if (message.subtype === "success") {
				const finished: AtelierEventBody = {
					type: "turn_finished",
					stopReason: message.stop_reason ?? "end_turn",
					usage,
					costUsd,
					...requests,
				};
				if (!message.is_error) return [finished];
				return [
					{ type: "error", code: "result_error", message: message.result || "The turn failed.", recoverable: true },
					finished,
				];
			}
			return [
				{
					type: "error",
					code: message.subtype,
					message: message.errors.join("\n") || message.subtype,
					recoverable: message.subtype === "error_during_execution",
				},
				{ type: "turn_finished", stopReason: message.subtype, usage, costUsd, ...requests },
			];
		}

		default:
			return [];
	}
}
