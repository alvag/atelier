#!/usr/bin/env node
import process from "node:process";
import { createBackend as createNamedBackend } from "../backend-factory.ts";
import { connectMemory } from "../memory/index.ts";
import { SYSTEM_PROMPT_APPEND } from "../prompt.ts";
import type { BackendName } from "../protocol/types.ts";
import { coreTools } from "../tools/index.ts";
import { EchoBackend } from "./echo-backend.ts";
import { RpcServer } from "./rpc-server.ts";

const USAGE = `Usage: atelier-core serve

Runs the Atelier core as a separate process speaking the Atelier protocol
(JSON lines) on stdin and stdout. Logs go to stderr.

Sessions use the claude-code backend (Claude subscription) unless session.start
asks for anthropic-api, which reads the API key from the macOS Keychain
(service atelier-anthropic).

Environment:
  ATELIER_BACKEND=echo   Network-free echo backend, for tests
  ANTHROPIC_API_KEY      API key for anthropic-api sessions, instead of the Keychain
  ATELIER_MEMORY=off     Run sessions without long-term memory
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

const createBackend = (name: BackendName) =>
	process.env.ATELIER_BACKEND === "echo" ? new EchoBackend() : createNamedBackend(name);

// The echo backend (tests) and ATELIER_MEMORY=off run without long-term memory.
const memoryOff = process.env.ATELIER_BACKEND === "echo" || process.env.ATELIER_MEMORY === "off";

const server = new RpcServer({
	input: process.stdin,
	write: (line) => process.stdout.write(line),
	createBackend,
	tools: coreTools,
	systemPromptAppend: SYSTEM_PROMPT_APPEND,
	...(memoryOff ? {} : { connectMemory: (cwd: string) => connectMemory({ cwd }) }),
});

await server.run();
// Exit once stdout is flushed, even if a closed session left a handle behind.
process.stdout.write("", () => process.exit(0));
