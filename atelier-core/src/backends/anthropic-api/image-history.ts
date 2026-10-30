import type Anthropic from "@anthropic-ai/sdk";
import { imageInputProblem, imageOmission } from "../../image-support.ts";

/** A request-time view: a model change must not destroy the pixels kept for resume or a later model. */
export function imageCompatibleRequest(
	params: Anthropic.MessageCreateParamsNonStreaming,
	backend: string,
): Anthropic.MessageCreateParamsNonStreaming {
	if (imageInputProblem(backend, params.model) === undefined) return params;
	const omitted = (image: Anthropic.ImageBlockParam): Anthropic.TextBlockParam => ({
		type: "text",
		text: imageOmission(params.model),
		...(image.cache_control ? { cache_control: image.cache_control } : {}),
	});
	return {
		...params,
		messages: params.messages.map((message) => {
			if (message.role !== "user" || typeof message.content === "string") return message;
			return {
				...message,
				content: message.content.map((block) => {
					if (block.type === "image") return omitted(block);
					if (block.type === "tool_result" && Array.isArray(block.content))
						return { ...block, content: block.content.map((part) => (part.type === "image" ? omitted(part) : part)) };
					return block;
				}),
			};
		}),
	};
}
