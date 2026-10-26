import type {
	AgentBackend,
	BackendSession,
	BackendStartOptions,
	BackendSummary,
	ResumeState,
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
	readonly id: string;
	readonly prompts: string[] = [];
	readonly toolResults: ToolCallResult[] = [];
	startOptions: BackendStartOptions | undefined;
	/** Every `configure` the session received. */
	readonly configured: SessionChange[] = [];
	/** `configure`, `send` and `summarize` in the order the session made them. */
	readonly calls: ("configure" | "send" | "summarize")[] = [];
	/** Set to false to play a backend that cannot change a session in place. */
	configurable = true;
	/** Set to false to play a backend that cannot summarize its conversation. */
	summarizable = true;
	/** What `summarize` answers; a string makes it fail with that message instead. */
	summary: BackendSummary | string = {
		text: "## Goal\n- carried",
		usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 },
		costUsd: 0.01,
		requests: 1,
	};
	/** What `resumeState` answers: the state a saved session would carry after the turns so far. */
	resumeState: ResumeState | undefined;
	/** Makes `start` fail with this message. */
	startError: string | undefined;
	/** Makes `close()` fail with this message, after the backend is closed. */
	closeError: string | undefined;
	interrupts = 0;
	closed = false;
	readonly #turns: FakeStep[][];

	constructor(turns: FakeStep[][], id = "fake") {
		this.id = id;
		this.#turns = [...turns];
	}

	async start(options: BackendStartOptions): Promise<BackendSession> {
		if (this.startError !== undefined) throw new Error(this.startError);
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
			...(backend.summarizable
				? {
						async summarize() {
							backend.calls.push("summarize");
							if (typeof backend.summary === "string") throw new Error(backend.summary);
							return backend.summary;
						},
					}
				: {}),
			resumeState: () => backend.resumeState,
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
				if (backend.closeError !== undefined) throw new Error(backend.closeError);
			},
		};
	}
}
