import type {
	AgentBackend,
	BackendSession,
	BackendStartOptions,
	SessionChange,
	ToolCall,
	ToolCallResult,
} from "./backend.ts";
import type { AtelierEventBody } from "./events.ts";

/** One scripted step of a fake turn. */
export type FakeStep =
	| { event: AtelierEventBody }
	| { toolCall: ToolCall }
	| { throw: string }
	/** Blocks until `interrupt()` is called, then yields `turn_finished` with stopReason "interrupted". */
	| { waitForInterrupt: true }
	/** Ignores `interrupt()` and blocks until `close()`, then ends the turn without finishing it. */
	| { hang: true };

/** Scripted backend for tests: each `send` plays the next turn of the script. */
export class FakeBackend implements AgentBackend {
	readonly id = "fake";
	readonly prompts: string[] = [];
	readonly toolResults: ToolCallResult[] = [];
	startOptions: BackendStartOptions | undefined;
	/** Every `configure` the session received. */
	readonly configured: SessionChange[] = [];
	/** `configure` and `send` in the order the session made them. */
	readonly calls: ("configure" | "send")[] = [];
	/** Set to false to play a backend that cannot change a session in place. */
	configurable = true;
	interrupts = 0;
	closed = false;
	readonly #turns: FakeStep[][];

	constructor(turns: FakeStep[][]) {
		this.#turns = [...turns];
	}

	async start(options: BackendStartOptions): Promise<BackendSession> {
		this.startOptions = options;
		let release: (() => void) | undefined;
		let interruptRequested = false;
		const closeWaiters: (() => void)[] = [];
		const backend = this;
		return {
			...(backend.configurable
				? {
						async configure(change: SessionChange) {
							backend.configured.push(change);
							backend.calls.push("configure");
						},
					}
				: {}),
			async *send(prompt: string): AsyncIterable<AtelierEventBody> {
				backend.prompts.push(prompt);
				backend.calls.push("send");
				interruptRequested = false;
				const steps = backend.#turns.shift() ?? [];
				for (const step of steps) {
					if ("event" in step) yield step.event;
					else if ("toolCall" in step) backend.toolResults.push(await options.executeTool(step.toolCall));
					else if ("throw" in step) throw new Error(step.throw);
					else if ("hang" in step) {
						if (!backend.closed) await new Promise<void>((resolve) => closeWaiters.push(resolve));
						return;
					} else {
						if (!interruptRequested)
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
				interruptRequested = true;
				release?.();
				release = undefined;
			},
			async close() {
				backend.closed = true;
				for (const resolve of closeWaiters.splice(0)) resolve();
			},
		};
	}
}
