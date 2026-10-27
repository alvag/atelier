#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
	type BackendName,
	connectMemory,
	createBackend as createNamedBackend,
	describeError,
	MemoryUnavailableError,
	memoryPromptsEnabled,
	openMcp,
	parseCompactAt,
} from "@atelier/core";
import { RpcClient } from "@atelier/core/client";
import { ProcessTerminal } from "@earendil-works/pi-tui";
import { run } from "./run.ts";

let compactAt: number | undefined;
try {
	compactAt = parseCompactAt(process.env.ATELIER_COMPACT_AT);
} catch (error) {
	process.stderr.write(`atelier: ${describeError(error)}\n`);
	process.exit(2);
}

// ATELIER_RECORD_SDK=<file.jsonl> appends every raw SDK message, to record test fixtures.
const recordPath = process.env.ATELIER_RECORD_SDK;
const createBackend = (name: BackendName) =>
	createNamedBackend(name, {
		...(recordPath
			? { claudeCode: { onSdkMessage: (message) => appendFileSync(recordPath, `${JSON.stringify(message)}\n`) } }
			: {}),
		...(compactAt === undefined ? {} : { anthropicApi: { compactAt } }),
	});

/** The core's protocol server, which the TUI runs as a separate process. */
const coreServer = fileURLToPath(new URL("src/server/main.ts", import.meta.resolve("@atelier/core/package.json")));
// ATELIER_TUI=off keeps the line-by-line session; recording SDK messages needs the session in this process.
const tui =
	process.stdin.isTTY && process.stdout.isTTY && process.env.ATELIER_TUI !== "off" && recordPath === undefined
		? {
				terminal: new ProcessTerminal(),
				connect: (env: Record<string, string>) =>
					RpcClient.connect({
						command: process.execPath,
						args: [coreServer, "serve"],
						env: { ...process.env, ...env },
					}),
			}
		: undefined;

const exitCode = await run(
	process.argv.slice(2),
	{
		stdin: process.stdin,
		isTTY: Boolean(process.stdin.isTTY),
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		cwd: process.cwd(),
		env: process.env,
		...(process.getuid ? { uid: process.getuid() } : {}),
		home: homedir(),
		color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined,
		...(process.stdin.isTTY && process.stdout.isTTY
			? { setRawMode: (on: boolean) => void process.stdin.setRawMode(on) }
			: {}),
		onInterrupt: (handler) => {
			process.on("SIGINT", handler);
			return () => process.off("SIGINT", handler);
		},
		onTerminate: (handler) => {
			const onTerm = () => handler(15);
			const onHup = () => handler(1);
			process.on("SIGTERM", onTerm);
			process.on("SIGHUP", onHup);
			return () => {
				process.off("SIGTERM", onTerm);
				process.off("SIGHUP", onHup);
			};
		},
		exit: (code) => process.exit(code),
		...(tui === undefined ? {} : { tui }),
	},
	createBackend,
	process.env.ATELIER_MEMORY === "off"
		? async () => {
				throw new MemoryUnavailableError("Memory is off (ATELIER_MEMORY=off).");
			}
		: async (cwd) => {
				const prompts = await memoryPromptsEnabled(process.env, homedir());
				const warnings = prompts.warning === undefined ? [] : [prompts.warning];
				return connectMemory({ cwd, prompts: prompts.enabled, warnings });
			},
	process.env.ATELIER_MCP === "off" ? undefined : (cwd) => openMcp({ cwd }),
);

// Exit only after stdout is flushed, so piped output is never cut short.
process.exitCode = exitCode;
process.stdout.write("", () => process.exit(exitCode));
