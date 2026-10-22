import type { AgentBackend, BackendSession, BackendStartOptions } from "../backend.ts";
import type { AtelierEventBody } from "../events.ts";

const BASH_PREFIX = "bash: ";

/**
 * Network-free backend for process tests and the desktop smoke test: echoes
 * the prompt, and a prompt "bash: <command>" calls the bash tool first.
 */
export class EchoBackend implements AgentBackend {
	readonly id = "echo";

	async start(options: BackendStartOptions): Promise<BackendSession> {
		return {
			async *send(prompt: string): AsyncIterable<AtelierEventBody> {
				yield { type: "session_started", backend: "echo", model: "echo", authSource: "none" };
				if (prompt.startsWith(BASH_PREFIX)) {
					const result = await options.executeTool({
						tool: "bash",
						input: { command: prompt.slice(BASH_PREFIX.length) },
					});
					yield { type: "text_delta", text: `bash ${result.ok ? "ok" : "failed"}` };
				} else {
					yield { type: "text_delta", text: "echo: " };
					yield { type: "text_delta", text: prompt };
				}
				yield {
					type: "turn_finished",
					stopReason: "end_turn",
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				};
			},
			interrupt: async () => {},
			close: async () => {},
		};
	}
}
