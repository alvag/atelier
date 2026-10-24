#!/usr/bin/env node
import { homedir } from "node:os";
import process from "node:process";
import { createBackend as createNamedBackend } from "../backend-factory.ts";
import { parseCompactAt } from "../compaction/compactor.ts";
import { describeError } from "../events.ts";
import { connectMemory, MemoryUnavailableError } from "../memory/index.ts";
import { SYSTEM_PROMPT_APPEND } from "../prompt.ts";
import type { BackendName } from "../protocol/types.ts";
import { checkRoot } from "../root.ts";
import { coreTools, sandboxEnabled } from "../tools/index.ts";
import { EchoBackend } from "./echo-backend.ts";
import { RpcServer, reviewEnabled } from "./rpc-server.ts";

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
  ATELIER_REVIEW=off     Run sessions without the review of uncommitted changes (RDD)
  ATELIER_SANDBOX=off    Run every session's bash without the macOS sandbox: each command asks,
                         and the verifier gets no bash (session.start can also ask for it)
  ATELIER_ALLOW_ROOT     As root (uid 0) the server refuses to start unless this is exactly
                         "I accept the risk"; it then warns on every start
  ATELIER_COMPACT_AT=<n> Context tokens at which anthropic-api sessions summarize their
                         older history (default: the model's window minus a reserve,
                         at most 200000; never more than the window minus the reserve)
`;

if (process.argv.length !== 3 || process.argv[2] !== "serve") {
	process.stderr.write(USAGE);
	process.exit(2);
}

const root = checkRoot(process.getuid?.(), process.env);
if (!root.allowed) {
	process.stderr.write(`atelier-core: ${root.message}\n`);
	process.exit(1);
}
if (root.warning) process.stderr.write(`atelier-core: ${root.warning}\n`);

// stdout belongs to the protocol: anything logged goes to stderr instead.
const toStderr = (...args: unknown[]) => process.stderr.write(`${args.map(String).join(" ")}\n`);
console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

let compactAt: number | undefined;
try {
	compactAt = parseCompactAt(process.env.ATELIER_COMPACT_AT);
} catch (error) {
	process.stderr.write(`atelier-core: ${describeError(error)}\n`);
	process.exit(2);
}

const createBackend = (name: BackendName) =>
	process.env.ATELIER_BACKEND === "echo"
		? new EchoBackend()
		: createNamedBackend(name, compactAt === undefined ? {} : { anthropicApi: { compactAt } });

// The echo backend (tests) and ATELIER_MEMORY=off run without long-term memory.
const memoryOff = process.env.ATELIER_BACKEND === "echo" || process.env.ATELIER_MEMORY === "off";

const server = new RpcServer({
	input: process.stdin,
	write: (line) => process.stdout.write(line),
	createBackend,
	review: reviewEnabled(process.env),
	noSandbox: !sandboxEnabled(process.env),
	tools: coreTools,
	systemPromptAppend: SYSTEM_PROMPT_APPEND,
	home: homedir(),
	connectMemory: memoryOff
		? async () => {
				throw new MemoryUnavailableError(
					process.env.ATELIER_MEMORY === "off"
						? "Memory is off (ATELIER_MEMORY=off)."
						: "No memory with the echo backend.",
				);
			}
		: (cwd: string) => connectMemory({ cwd }),
});

await server.run();
// Exit once stdout is flushed, even if a closed session left a handle behind.
process.stdout.write("", () => process.exit(0));
