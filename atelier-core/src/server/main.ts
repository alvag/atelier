#!/usr/bin/env node
import process from "node:process";
import type { AgentBackend } from "../backend.ts";
import { ClaudeCodeBackend } from "../backends/claude-code/backend.ts";
import { SYSTEM_PROMPT_APPEND } from "../prompt.ts";
import { coreTools } from "../tools/index.ts";
import { EchoBackend } from "./echo-backend.ts";
import { RpcServer } from "./rpc-server.ts";

const USAGE = `Usage: atelier-core serve

Runs the Atelier core as a separate process speaking the Atelier protocol
(JSON lines) on stdin and stdout. Logs go to stderr.

Environment:
  ATELIER_BACKEND=echo   Network-free echo backend, for tests
`;

if (process.argv.length !== 3 || process.argv[2] !== "serve") {
	process.stderr.write(USAGE);
	process.exit(2);
}

// stdout belongs to the protocol: anything logged goes to stderr instead.
const toStderr = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(" ")}\n`);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

const createBackend = (): AgentBackend =>
	process.env.ATELIER_BACKEND === "echo" ? new EchoBackend() : new ClaudeCodeBackend();

const server = new RpcServer({
	input: process.stdin,
	write: (line) => process.stdout.write(line),
	createBackend,
	tools: coreTools,
	systemPromptAppend: SYSTEM_PROMPT_APPEND,
});

await server.run();
// Exit once stdout is flushed, even if a closed session left a handle behind.
process.stdout.write("", () => process.exit(0));
