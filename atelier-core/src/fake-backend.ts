import type { AgentBackend, BackendSession, BackendStartOptions, ToolCall, ToolCallResult } from "./backend.ts";
import type { AtelierEventBody } from "./events.ts";

/** One scripted step of a fake turn. */
export type FakeStep =
	| { event: AtelierEventBody }
	| { toolCall: ToolCall }
	| { throw: string }
	/** Blocks until `interrupt()` is called, then yields `turn_finished` with stopReason "interrupted". */
	| { waitForInterrupt: true };

/** Scripted backend for tests: each `send` plays the next turn of the script. */
export class FakeBackend implements AgentBackend {
	readonly id = "fake";
	readonly prompts: string[] = [];
	readonly toolResults: ToolCallResult[] = [];
	startOptions: BackendStartOptions | undefined;
	interrupts = 0;
	closed = false;
	readonly #turns: FakeStep[][];

	constructor(turns: FakeStep[][]) {
		this.#turns = [...turns];
	}

	async start(options: BackendStartOptions): Promise<BackendSession> {
		this.startOptions = options;
		let release: (() => void) | undefined;
		const backend = this;
		return {
			async *send(prompt: string): AsyncIterable<AtelierEventBody> {
				backend.prompts.push(prompt);
				const steps = backend.#turns.shift() ?? [];
				for (const step of steps) {
					if ("event" in step) yield step.event;
					else if ("toolCall" in step) backend.toolResults.push(await options.executeTool(step.toolCall));
					else if ("throw" in step) throw new Error(step.throw);
					else {
						await new Promise<void>((resolve) => {
							release = resolve;
						});
						yield {
							type: "turn_finished",
							stopReason: "interrupted",
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						};
						return;
					}
				}
			},
			async interrupt() {
				backend.interrupts++;
				release?.();
				release = undefined;
			},
			async close() {
				backend.closed = true;
			},
		};
	}
}
