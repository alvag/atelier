#!/usr/bin/env node
import process from "node:process";
import { run } from "./run.ts";

const exitCode = await run(process.argv.slice(2), {
	stdin: process.stdin,
	isTTY: Boolean(process.stdin.isTTY),
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	cwd: process.cwd(),
	color: Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined,
	onInterrupt: (handler) => {
		process.on("SIGINT", handler);
		return () => process.off("SIGINT", handler);
	},
	exit: (code) => process.exit(code),
});

// Exit only after stdout is flushed, so piped output is never cut short.
process.exitCode = exitCode;
process.stdout.write("", () => process.exit(exitCode));
