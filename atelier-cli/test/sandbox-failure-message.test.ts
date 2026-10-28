import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createBashTool, FakeBackend, Sandbox, type SandboxManagerLike } from "@atelier/core";
import { expect, it } from "vitest";
import { run } from "../src/run.ts";

it("does not recommend yolo after normal mode denies a command because sandbox startup failed", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "cli-failure-probe-"));
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: ["proxy dependency missing"], warnings: [] }),
		initialize: async () => {},
		wrapWithSandbox: async (command) => command,
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	const backend = new FakeBackend([
		[
			{ toolCall: { tool: "bash", callId: "c1", input: { command: "printf safe" } } },
			{
				event: {
					type: "turn_finished",
					stopReason: "end_turn",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				},
			},
		],
	]);
	let stderr = "";
	try {
		const code = await run(
			["--mode", "normal", "--no-session", "--no-review", "go"],
			{
				stdin: new PassThrough(),
				isTTY: false,
				stdout: () => {},
				stderr: (text) => {
					stderr += text;
				},
				cwd,
				home: cwd,
				tools: [createBashTool({ sandbox: new Sandbox({ platform: "darwin", manager, outside: () => false }) })],
				color: false,
				env: {},
			},
			() => backend,
		);
		expect(code).toBe(0);
		expect(backend.toolResults).toEqual([{ ok: false, output: "The user denied this command." }]);
		expect(stderr).not.toContain("--mode yolo allows it");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
