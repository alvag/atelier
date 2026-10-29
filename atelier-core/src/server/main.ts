#!/usr/bin/env node
import { homedir } from "node:os";
import process from "node:process";
import { createBackend as createNamedBackend } from "../backend-factory.ts";
import { signedInBackends } from "../claude-code-auth.ts";
import { parseCompactAt } from "../compaction/compactor.ts";
import { describeError } from "../events.ts";
import { openMcp } from "../mcp/index.ts";
import { connectMemory, MemoryUnavailableError, memoryPromptsEnabled } from "../memory/index.ts";
import {
	catalogFile,
	DynamicModelCatalog,
	defaultCatalogSources,
	modelRefreshEnabled,
} from "../model-catalog/index.ts";
import { SYSTEM_PROMPT_APPEND } from "../prompt.ts";
import { BACKEND_NAMES, type BackendName } from "../protocol/types.ts";
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
  ATELIER_MEMORY_PROMPTS=off
                         Keep the user's prompts out of long-term memory
  ATELIER_MCP=off        Run sessions without the MCP servers of ~/.atelier/mcp.json
  ATELIER_REVIEW=off     Run sessions without the review of uncommitted changes (RDD)
  ATELIER_SANDBOX=off    Run every session's bash without the macOS sandbox: each command asks,
                         and the verifier gets no bash (session.start can also ask for it)
  ATELIER_LOGIN_CHECK=off
                         Offer every backend's models in options.list, and keep the model
                         catalog to models.dev, reading no credential; unset, it asks Claude
                         Code, auth.json and the Keychain which backends are signed in
  ATELIER_MODEL_REFRESH=off
                         Offer the models of the code and of ~/.atelier/models.json
                         without asking models.dev or the providers for new ones
  ATELIER_OFFLINE=1      The same (any value but empty or 0)
  ATELIER_ALLOW_ROOT     As root (uid 0) the server refuses to start unless this is exactly
                         "I accept the risk"; it then warns on every start
  ATELIER_COMPACT_AT=<n> Context tokens at which the sessions Atelier compacts summarize
                         their older history (default: the model's window minus 16384,
                         and 32000 more on openai-codex; it can only lower that point;
                         Claude Code compacts on its own)
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

// The model lists: the code's, then what the providers listed, refreshed in the background. The echo backend has none.
const catalog =
	process.env.ATELIER_BACKEND === "echo"
		? undefined
		: new DynamicModelCatalog({
				file: catalogFile(homedir()),
				sources: defaultCatalogSources({ home: homedir(), env: process.env }),
				network: modelRefreshEnabled(process.env),
			});
void catalog?.start();

const createBackend = (name: BackendName) =>
	process.env.ATELIER_BACKEND === "echo"
		? new EchoBackend()
		: createNamedBackend(name, {
				...(compactAt === undefined ? {} : { anthropicApi: { compactAt }, openaiCodex: { compactAt } }),
				...(catalog === undefined
					? {}
					: {
							claudeCode: {
								listModels: (list) => void catalog.listClaudeCode(list),
								onContextWindows: (windows) => void catalog.noteClaudeCodeWindows(windows),
							},
						}),
			});

// The models options.list offers: the echo backend (tests) has none, ATELIER_LOGIN_CHECK=off asks nothing.
const signedIn = async (): Promise<readonly BackendName[]> =>
	process.env.ATELIER_BACKEND === "echo"
		? []
		: process.env.ATELIER_LOGIN_CHECK === "off"
			? BACKEND_NAMES
			: signedInBackends();

// The echo backend (tests) and ATELIER_MEMORY=off run without long-term memory.
const memoryOff = process.env.ATELIER_BACKEND === "echo" || process.env.ATELIER_MEMORY === "off";

// The echo backend (tests) and ATELIER_MCP=off run without the user's MCP servers.
const mcpOff = process.env.ATELIER_BACKEND === "echo" || process.env.ATELIER_MCP === "off";

const server = new RpcServer({
	input: process.stdin,
	write: (line) => process.stdout.write(line),
	createBackend,
	signedIn,
	...(catalog === undefined ? {} : { catalog }),
	review: reviewEnabled(process.env),
	noSandbox: !sandboxEnabled(process.env),
	tools: coreTools,
	systemPromptAppend: SYSTEM_PROMPT_APPEND,
	home: homedir(),
	// The echo backend (tests) leaves nothing behind in the home.
	sessions: process.env.ATELIER_BACKEND !== "echo",
	connectMemory: memoryOff
		? async () => {
				throw new MemoryUnavailableError(
					process.env.ATELIER_MEMORY === "off"
						? "Memory is off (ATELIER_MEMORY=off)."
						: "No memory with the echo backend.",
				);
			}
		: async (cwd: string) => {
				const prompts = await memoryPromptsEnabled(process.env, homedir());
				const warnings = prompts.warning === undefined ? [] : [prompts.warning];
				return connectMemory({ cwd, prompts: prompts.enabled, warnings });
			},
	...(mcpOff ? {} : { connectMcp: (cwd: string) => openMcp({ cwd }) }),
});

await server.run();
// Exit once stdout is flushed, even if a closed session left a handle behind.
process.stdout.write("", () => process.exit(0));
