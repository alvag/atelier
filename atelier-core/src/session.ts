import { randomUUID } from "node:crypto";
import type { AgentBackend, BackendSession, ToolCall, ToolCallResult } from "./backend.ts";
import { Channel } from "./channel.ts";
import { type AtelierEvent, type AtelierEventBody, describeError, errorEvent, ZERO_USAGE } from "./events.ts";
import { type ToolDefinition, ToolInputError } from "./tools/types.ts";

export interface ApprovalRequest {
	callId: string;
	command: string;
}

export interface SessionOptions {
	backend: AgentBackend;
	cwd: string;
	model?: string;
	tools: readonly ToolDefinition[];
	systemPromptAppend?: string;
	/** Skips approval for every tool call (`--yes`). */
	autoApprove?: boolean;
	/** Asks the user; without it, calls that need approval are denied. */
	approve?: (request: ApprovalRequest) => Promise<boolean>;
	createId?: () => string;
}

/**
 * Orchestrates turns against one backend. It stamps every event, merges tool
 * events into the turn stream, owns tool execution and approval, and
 * guarantees each turn ends with exactly one `turn_finished`.
 */
export class Session {
	readonly #options: SessionOptions;
	readonly #tools: Map<string, ToolDefinition>;
	readonly #createId: () => string;
	#backendSession: BackendSession | undefined;
	#turn: Channel<AtelierEventBody> | undefined;
	#abort: AbortController | undefined;
	#closed = false;
	#closing: Promise<void> | undefined;

	private constructor(options: SessionOptions) {
		this.#options = options;
		this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
		this.#createId = options.createId ?? randomUUID;
	}

	static async start(options: SessionOptions): Promise<Session> {
		const session = new Session(options);
		session.#backendSession = await options.backend.start({
			cwd: options.cwd,
			...(options.model === undefined ? {} : { model: options.model }),
			systemPromptAppend: options.systemPromptAppend ?? "",
			tools: options.tools,
			executeTool: (call) => session.#executeTool(call),
		});
		return session;
	}

	get busy(): boolean {
		return this.#turn !== undefined;
	}

	async *send(prompt: string): AsyncGenerator<AtelierEvent> {
		const turnId = this.#createId();
		let seq = 0;
		const stamp = (body: AtelierEventBody): AtelierEvent => ({ ...body, seq: ++seq, turnId });

		const backendSession = this.#backendSession;
		if (this.#closed || !backendSession) {
			yield stamp(errorEvent("session_closed", "The session is closed."));
			yield stamp({ type: "turn_finished", stopReason: "error", usage: { ...ZERO_USAGE } });
			return;
		}
		if (this.#turn) {
			yield stamp(errorEvent("busy", "A turn is already running.", true));
			yield stamp({ type: "turn_finished", stopReason: "error", usage: { ...ZERO_USAGE } });
			return;
		}

		const turn = new Channel<AtelierEventBody>();
		this.#turn = turn;
		this.#abort = new AbortController();
		const pump = (async () => {
			let finish: AtelierEventBody | undefined;
			let failed = false;
			try {
				for await (const event of backendSession.send(prompt)) {
					if (event.type === "turn_finished") finish ??= event;
					else {
						if (event.type === "error") failed = true;
						turn.push(event);
					}
				}
			} catch (error) {
				failed = true;
				turn.push(errorEvent("backend_error", describeError(error)));
			}
			turn.push(
				finish ?? { type: "turn_finished", stopReason: failed ? "error" : "incomplete", usage: { ...ZERO_USAGE } },
			);
			turn.close();
		})();

		try {
			for await (const body of turn) yield stamp(body);
		} finally {
			if (!turn.closed) {
				this.#abort?.abort();
				await backendSession.interrupt().catch(() => {});
			}
			await pump;
			this.#turn = undefined;
			this.#abort = undefined;
		}
	}

	/** Aborts running tools and asks the backend to stop the turn. */
	async interrupt(): Promise<void> {
		if (!this.#turn) return;
		this.#abort?.abort();
		await this.#backendSession?.interrupt();
	}

	/** Closes the backend; every call waits for the same close to finish. */
	close(): Promise<void> {
		if (!this.#closing) {
			this.#closed = true;
			this.#closing = Promise.resolve(this.#backendSession?.close());
		}
		return this.#closing;
	}

	async #executeTool(call: ToolCall): Promise<ToolCallResult> {
		const callId = call.callId ?? this.#createId();
		const emit = (event: AtelierEventBody) => this.#turn?.push(event);
		emit({ type: "tool_call_started", callId, tool: call.tool, input: call.input });

		const fail = (summary: string): ToolCallResult => {
			emit({ type: "tool_call_finished", callId, ok: false, summary, truncated: false });
			return { ok: false, output: summary };
		};

		const tool = this.#tools.get(call.tool);
		if (!tool) return fail(`Unknown tool: ${call.tool}`);

		try {
			const command = tool.approvalCommand(call.input);
			if (command !== undefined && !this.#options.autoApprove) {
				emit({ type: "approval_requested", callId, command });
				const approved = (await this.#options.approve?.({ callId, command })) ?? false;
				if (!approved) return fail("The user denied this command.");
			}
			const signal = this.#abort?.signal;
			const outcome = await tool.execute(call.input, { cwd: this.#options.cwd, ...(signal ? { signal } : {}) });
			emit({
				type: "tool_call_finished",
				callId,
				ok: outcome.ok,
				summary: outcome.summary,
				truncated: outcome.truncated,
				...(outcome.fullOutputPath === undefined ? {} : { fullOutputPath: outcome.fullOutputPath }),
			});
			return { ok: outcome.ok, output: outcome.output };
		} catch (error) {
			const prefix = error instanceof ToolInputError ? "Invalid input" : "Tool failed";
			return fail(`${prefix}: ${describeError(error)}`);
		}
	}
}
