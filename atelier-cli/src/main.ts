#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import process from "node:process";
import {
	type BackendName,
	connectMemory,
	createBackend as createNamedBackend,
	describeError,
	MemoryUnavailableError,
	parseCompactAt,
} from "@atelier/core";
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

const exitCode = await run(
	process.argv.slice(2),
	{
		stdin: process.stdin,
		isTTY: Boolean(process.stdin.isTTY),
		stdout: (text) => process.stdout.write(text),
		stderr: (text) => process.stderr.write(text),
		cwd: process.cwd(),
		env: process.env,
		home: homedir(),
		color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined,
		onInterrupt: (handler) => {
			process.on("SIGINT", handler);
			return () => process.off("SIGINT", handler);
		},
		exit: (code) => process.exit(code),
	},
	createBackend,
	process.env.ATELIER_MEMORY === "off"
		? async () => {
				throw new MemoryUnavailableError("Memory is off (ATELIER_MEMORY=off).");
			}
		: (cwd) => connectMemory({ cwd }),
);

// Exit only after stdout is flushed, so piped output is never cut short.
process.exitCode = exitCode;
process.stdout.write("", () => process.exit(exitCode));
