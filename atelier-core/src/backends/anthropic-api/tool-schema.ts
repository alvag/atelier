import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ToolDefinition } from "../../tools/types.ts";

/**
 * Converts core tools to Messages API tool definitions, keeping their order.
 * The output must be byte-stable: tools are the first part of the cached prefix.
 */
export function toAnthropicTools(tools: readonly ToolDefinition[]): Anthropic.Tool[] {
	return tools.map((tool) => {
		const { $schema: _dialect, ...schema } = z.toJSONSchema(z.object(tool.inputShape)) as Record<string, unknown>;
		return {
			name: tool.name,
			description: tool.description,
			input_schema: { ...schema, type: "object" },
		};
	});
}
