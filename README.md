# Atelier

Coding-agent orchestrator with two first-class clients, a CLI and a desktop app, on top of one headless core.

| Package            | Directory          | Status                                                  |
| ------------------ | ------------------ | ------------------------------------------------------- |
| `@atelier/core`    | `atelier-core/`    | M1: event contract, session, tools, Claude Code backend |
| `@atelier/cli`     | `atelier-cli/`     | M1: `atelier` command                                   |
| `@atelier/desktop` | `atelier-desktop/` | M2                                                      |

## Requirements

- Node 22.18+ (TypeScript runs natively; there is no build step) and pnpm.
- Claude Code logged in with your Claude subscription: run `claude` and use `/login`.

## Usage

```bash
pnpm install
pnpm atelier "add email validation to src/user.ts and run the tests"   # one turn
pnpm atelier                                                          # interactive; /exit or Ctrl+D to quit
```

| Option                             | Effect                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `-y`, `--yes`                      | Run `bash` commands without asking. Without it, commands are asked on a terminal and denied otherwise. |
| `--model <name>`                   | Model to use (default: `opus`).                                                                        |
| `--cwd <dir>`                      | Working directory (default: current directory).                                                        |
| `-h`, `--help` / `-v`, `--version` | Help and version.                                                                                      |

Output shows streamed text, one line per tool call (`▸ edit src/user.ts (1 edit) ✓`) and the turn's tokens, including prompt cache reads and writes. A warning appears when the session is not using a Claude subscription.

Exit codes: `0` ok, `1` failed turn, `2` usage error, `130` interrupted.

Ctrl+C interrupts the running turn (and answers no to a pending approval); with no turn running, or pressed twice, it closes the session.

## Desktop app

```bash
pnpm desktop            # dev mode with hot reload
pnpm -C atelier-desktop smoke   # build + Playwright smoke test (echo backend, no network)
```

Open a folder, pick a model and chat. Each tool call shows as a row with its status; `bash` commands ask for approval in a card that shows invisible and control characters as visible markers. Every turn ends with its tokens; the status bar shows the core status, warnings and the latest error. If the core process dies, the app says so and offers a restart.

The desktop starts the core with Electron's own Node (no system Node needed) and talks to it over the Atelier protocol: one JSON message per line on stdin/stdout, a `hello` with the protocol version, an `id` on every command and exactly one response per command, and events tagged with their session. See `../docs/m2-diseno.md`.

## How it works

- The core emits plain-JSON `AtelierEvent`s; clients only render them. Every turn ends with exactly one `turn_finished`.
- The agent only has Atelier's tools: `read`, `edit`, `bash`, `grep`. The core executes them and owns approval. File tools are confined to the working directory; `bash` is not confined and is gated by approval instead.
- `ClaudeCodeBackend` drives Claude Code through the Claude Agent SDK, isolated from your `~/.claude` setup (no settings, hooks, plugins, skills, CLAUDE.md or other MCP servers) and without `ANTHROPIC_API_KEY`, so it uses your subscription.

Design and decisions: `../docs/m1-diseno.md`.

## Development

```bash
pnpm check   # lint + typecheck + test (no network, no subscription usage)
```

`ATELIER_RECORD_SDK=<file.jsonl>` appends every raw SDK message during a real run; that is how `atelier-core/test/fixtures/claude-code/` is recorded.
