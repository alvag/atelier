import { z } from "zod";

export interface ToolContext {
	/** Absolute working directory; every path a tool touches must stay inside it. */
	cwd: string;
	signal?: AbortSignal;
}

export interface ToolOutcome {
	ok: boolean;
	/** Text returned to the model. */
	output: string;
	/** One line for the user interface. */
	summary: string;
	truncated: boolean;
	fullOutputPath?: string;
}

/** A tool as the core and every backend see it: input is validated before it reaches `execute`. */
export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputShape: z.ZodRawShape;
	/** Returns the command the user must approve, or undefined when no approval is needed. */
	approvalCommand(input: unknown): string | undefined;
	execute(input: unknown, context: ToolContext): Promise<ToolOutcome>;
}

export interface ToolSpec<Shape extends z.ZodRawShape> {
	name: string;
	description: string;
	inputShape: Shape;
	approvalCommand?: (input: z.output<z.ZodObject<Shape>>) => string | undefined;
	execute: (input: z.output<z.ZodObject<Shape>>, context: ToolContext) => Promise<ToolOutcome>;
}

export class ToolInputError extends Error {
	override name = "ToolInputError";
}

export function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): ToolDefinition {
	const schema = z.object(spec.inputShape);
	const parse = (input: unknown) => {
		const result = schema.safeParse(input);
		if (!result.success) throw new ToolInputError(z.prettifyError(result.error));
		return result.data;
	};
	return {
		name: spec.name,
		description: spec.description,
		inputShape: spec.inputShape,
		approvalCommand: (input) => spec.approvalCommand?.(parse(input)),
		execute: async (input, context) => spec.execute(parse(input), context),
	};
}
