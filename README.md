# Atelier

Coding-agent orchestrator with two first-class clients, a CLI and a desktop app, on top of one headless core.

| Package            | Directory          | Status                                                                                                           |
| ------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `@atelier/core`    | `atelier-core/`    | Event contract, session, tools, subagents, protocol server; backends `claude-code` (M1) and `anthropic-api` (M3) |
| `@atelier/cli`     | `atelier-cli/`     | `atelier` command                                                                                                |
| `@atelier/desktop` | `atelier-desktop/` | Desktop chat app (M2)                                                                                            |

## Requirements

- Node 22.18+ (TypeScript runs natively; there is no build step) and pnpm.
- For the default `claude-code` backend: Claude Code logged in with your Claude subscription (run `claude` and use `/login`).
- For the `anthropic-api` backend: an Anthropic API key with credit, stored once in the macOS Keychain. The command asks for the key, so it stays out of your shell history:

  ```bash
  security add-generic-password -U -s atelier-anthropic -a "$USER" -w
  ```

  `ANTHROPIC_API_KEY` set for a single command takes priority. Do not export it in your shell profile: Claude Code would then bill the API instead of your subscription.

## Usage

```bash
pnpm install
pnpm atelier "add email validation to src/user.ts and run the tests"   # one turn
pnpm atelier                                                          # interactive; /exit or Ctrl+D to quit
```

| Option                             | Effect                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `-y`, `--yes`                      | Run `bash` commands without asking. Without it, commands are asked on a terminal and denied otherwise.       |
| `--backend <name>`                 | `claude-code` (default, Claude subscription) or `anthropic-api` (Atelier's own loop, billed to the API key). |
| `--model <name>`                   | Model to use (default: `opus` on `claude-code`, `claude-sonnet-5-5` on `anthropic-api`).                     |
| `--cwd <dir>`                      | Working directory (default: current directory).                                                              |
| `-h`, `--help` / `-v`, `--version` | Help and version.                                                                                            |

Output shows streamed text, one line per tool call (`▸ edit src/user.ts (1 edit) ✓`) and the turn's tokens: input, output, cache reads and writes, the share of the prompt served from the cache (`cacheRead / (input + cacheRead + cacheWrite)`), the number of model requests and the cost. A `cache miss` line says why the prompt cache could not be reused. On `claude-code`, a warning appears when the session is not using a Claude subscription.

Exit codes: `0` ok, `1` failed turn, `2` usage error, `130` interrupted.

Ctrl+C interrupts the running turn (and answers no to a pending approval); with no turn running, or pressed twice, it closes the session.

## Desktop app

```bash
pnpm desktop            # dev mode with hot reload
pnpm -C atelier-desktop smoke   # build + Playwright smoke test (echo backend, no network)
```

Open a folder, pick a backend and a model, and chat. Each tool call shows as a row with its status; `bash` commands ask for approval in a card that shows invisible and control characters as visible markers. Every turn ends with its tokens; the status bar shows the core status, warnings and the latest error. If the core process dies, the app says so and offers a restart.

The desktop starts the core with Electron's own Node (no system Node needed) and talks to it over the Atelier protocol (version 3): one JSON message per line on stdin/stdout, a `hello` with the protocol version, an `id` on every command and exactly one response per command, and events tagged with their session. See `../docs/m2-diseno.md`.

## How it works

- The core emits plain-JSON `AtelierEvent`s; clients only render them. Every turn ends with exactly one `turn_finished`.
- The agent only has Atelier's tools: `read`, `edit`, `bash`, `grep`. The core executes them and owns approval. File tools are confined to the working directory; `bash` is not confined and is gated by approval instead.
- `ClaudeCodeBackend` drives Claude Code through the Claude Agent SDK, isolated from your `~/.claude` setup (no settings, hooks, plugins, skills, CLAUDE.md or other MCP servers) and without `ANTHROPIC_API_KEY`, so it uses your subscription.
- `AnthropicApiBackend` runs Atelier's own loop on the Messages API. It owns the prompt: tools and system prompt are fixed for the session, and three cache breakpoints (last tool, system, last message) keep the prefix cached. Each request asks the API to compare its prefix with the previous response, which is how cache misses are reported. See `../docs/m3-diseno.md`; a measured session is in `../docs/m3-medicion.md`.
- Subagents: the agent can delegate with a `task` tool to `explorer` (read and grep only, on the cheapest model: `haiku` / `claude-haiku-5-5`) or `worker` (read, edit, grep, bash, on the session's model). A subagent runs in its own session with only the task prompt and its role's instructions, on a fresh backend of the same kind. Only its final report, cut in code at 8,000 characters, returns to the parent. Its work shows nested under the task call: indented under `↳ agent · model` in the CLI, in a foldable block in the desktop, each with its own token line. Its bash commands ask for approval like any other. See `../docs/m4-diseno.md` and `../docs/m4-medicion.md`.
- ODD (Organic Driven Development) is core state, not prompt prose. For large work the agent keeps a feature document in `odd/tasks/<name>.md` (`## Specs`, `## Tasks`, `## Log`) through the `feature` tool, the only way to change it: `edit` refuses that directory. Atelier writes the log's user entries itself, verbatim (L1 is the original request), so the model never paraphrases you. Each change is validated and written as one transaction, so the document stays well formed. A later session resumes with `open`. The current phase (exploring, implementing, checking…) is inferred from the tools, or declared with the `phase` tool. The CLI prints `· <phase>` and `◆ <feature>: n/m done`; the desktop shows the phase in the status bar and the feature's tasks in a side panel. See `../docs/m5-diseno.md`.
- `bash` runs without `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`. That only filters its environment; it is not isolation (a command could still inspect processes or ask the Keychain). Keep approvals on (no `--yes`) for work you do not trust.

Design and decisions: `../docs/m1-diseno.md`, `../docs/m2-diseno.md`, `../docs/m3-diseno.md`, `../docs/m4-diseno.md`, `../docs/m5-diseno.md`.

## Development

```bash
pnpm check   # lint + typecheck + test (no network, no subscription usage)
node atelier-core/scripts/measure-cache.ts       # measures the prompt cache on the real API (costs a few cents)
node atelier-core/scripts/measure-subagents.ts   # same question with and without a subagent, on the real API
```

`ATELIER_RECORD_SDK=<file.jsonl>` appends every raw SDK message during a real run; that is how `atelier-core/test/fixtures/claude-code/` is recorded.
