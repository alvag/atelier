import { z } from "zod";
import type { SandboxStatus } from "./sandbox.ts";

export interface ToolContext {
	/** Absolute working directory; every path a tool touches must stay inside it. */
	cwd: string;
	signal?: AbortSignal;
	/** Session-owned temporary directory: tools may write there, `read` may read it, and it is deleted when the session closes. */
	scratchDir?: string;
	/** The call being executed. */
	callId?: string;
	/** The session runs with the sandbox turned off (`--no-sandbox`): `bash` runs unsandboxed and every command asks. */
	sandboxOff?: boolean;
	/** Real paths outside the usual places that the user approved for the rest of the session; `edit` and `write` write only those. */
	approvedPaths?: ReadonlySet<string>;
}

/** What a tool says about a call before it runs. */
export interface ToolGate {
	/** The call never runs and nobody is asked: `output` is what the model is told, `summary` the line for the user. */
	refusal?: { output: string; summary: string };
	/**
	 * The call reaches what the sandbox does not contain (a command outside it, any command without it, a file
	 * outside the usual places): `normal` and `auto` ask the user, `yolo` does not. `reason` is the model's own.
	 */
	approval?: {
		command: string;
		reason?: string;
		/** The tool asking, when the client should word the question for it (`edit`, `write`); absent for `bash`. */
		tool?: string;
		/** A real path that stays allowed for the rest of the session once the user approves. */
		grant?: string;
		/** What the model is told when the user denies, or there is nobody to ask. */
		denial?: string;
	};
	/** Said once per turn, before the first question: why the call runs without the protection it normally has. */
	warning?: string;
}

export interface ToolOutcome {
	ok: boolean;
	/** Text returned to the model. */
	output: string;
	/** One line for the user interface. */
	summary: string;
	truncated: boolean;
	fullOutputPath?: string;
	/** What the sandbox blocked in the call, as short causes; absent when it reported nothing. */
	blocked?: string[];
}

/** A tool as the core and every backend see it: input is validated before it reaches `execute`. */
export interface ToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly inputShape: z.ZodRawShape;
	/** Returns the command the user must approve, or undefined when no approval is needed. */
	approvalCommand(input: unknown): string | undefined;
	/** Decides before the call runs; a tool without it only has `approvalCommand`. */
	gate?(input: unknown, context: ToolContext): Promise<ToolGate>;
	execute(input: unknown, context: ToolContext): Promise<ToolOutcome>;
	/** Whether the tool's commands run in the sandbox; only the main agent's `bash` has it. Does not run a command. */
	sandboxStatus?(context: ToolContext): Promise<SandboxStatus>;
}

export interface ToolSpec<Shape extends z.ZodRawShape> {
	name: string;
	description: string;
	inputShape: Shape;
	approvalCommand?: (input: z.output<z.ZodObject<Shape>>) => string | undefined;
	gate?: (input: z.output<z.ZodObject<Shape>>, context: ToolContext) => Promise<ToolGate>;
	execute: (input: z.output<z.ZodObject<Shape>>, context: ToolContext) => Promise<ToolOutcome>;
	sandboxStatus?: (context: ToolContext) => Promise<SandboxStatus>;
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
	const gate = spec.gate;
	const sandboxStatus = spec.sandboxStatus;
	return {
		name: spec.name,
		description: spec.description,
		inputShape: spec.inputShape,
		approvalCommand: (input) => spec.approvalCommand?.(parse(input)),
		...(gate ? { gate: async (input: unknown, context: ToolContext) => gate(parse(input), context) } : {}),
		execute: async (input, context) => spec.execute(parse(input), context),
		...(sandboxStatus ? { sandboxStatus } : {}),
	};
}
