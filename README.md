# Atelier

Coding-agent orchestrator with two first-class clients, a terminal UI and a desktop app, on top of one headless core.
- Runs on your Claude subscription through Claude Code, or on its own loop with an Anthropic API key.
- Delegates to subagents, keeps large work in feature documents following Organic Driven Development (ODD), and remembers across sessions with [Engram](https://github.com/Gentleman-Programming/engram) when it is installed.
- Reviews the changes of every turn with receipts and verifies high-risk ones independently.
- Runs `bash` inside the macOS sandbox and asks before anything the sandbox cannot make safe.

## Requirements

- Node 22.19+ and pnpm. TypeScript runs natively; there is no build step.
- For the default `claude-code` backend: Claude Code logged in with your Claude subscription (run `claude` and use `/login`).
- For the `anthropic-api` backend: an Anthropic API key with credit, stored once in the macOS Keychain. The command asks for the key, so it stays out of your shell history:

  ```bash
  security add-generic-password -U -s atelier-anthropic -a "$USER" -w
  ```

  `ANTHROPIC_API_KEY` set for a single command takes priority. Do not export it in your shell profile: Claude Code would then bill the API instead of your subscription.
- Optional: [Engram](https://github.com/Gentleman-Programming/engram) 3.4.0 or newer for long-term memory.

## Install

```bash
git clone https://github.com/alvag/atelier.git
cd atelier
pnpm install
```

## Usage

```bash
pnpm atelier                                                          # interactive session in the current directory
pnpm atelier "add email validation to src/user.ts and run the tests"   # one turn, then exit
pnpm atelier --cwd ~/code/my-app                                      # work on another directory
pnpm atelier --continue                                               # resume the newest session of the directory
```

| Option                             | Effect                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `--mode <mode>`                    | Permission mode: `normal` (default), `auto` or `yolo` (see below).                       |
| `--backend <name>`                 | `claude-code` (default, Claude subscription) or `anthropic-api` (billed to the API key). |
| `--model <name>`                   | Model to use (default: `opus` on `claude-code`, `claude-sonnet-5-5` on `anthropic-api`). |
| `--profile <name>`                 | Agent profile for this session (see [profiles](docs/profiles.md)).                       |
| `--cwd <dir>`                      | Working directory (default: current directory).                                          |
| `--continue`                       | Resume the newest saved session of the working directory.                                |
| `--resume <id>`                    | Resume that saved session of the working directory.                                      |
| `--no-session`                     | Do not save this session.                                                                |
| `--no-review`                      | Do not review or verify changes.                                                         |
| `--no-sandbox`                     | Run `bash` without the macOS sandbox.                                                    |
| `-h`, `--help` / `-v`, `--version` | Help and version.                                                                        |

Exit codes: `0` ok, `1` failed turn, `2` usage error, `130` interrupted.

### Commands

| Command                   | Effect                                                                 |
| ------------------------- | ---------------------------------------------------------------------- |
| `/model [name]`           | Change the model from the next turn; without a name, pick from a list. |
| `/effort [level]`         | Change the thinking level (`off`, `minimal`, `low` … `max`).           |
| `/profile [name]`         | Change the agent profile.                                              |
| `/mode [mode]`            | Change the permission mode; `/mode default <mode>` saves the default.  |
| `/backend [name]`         | Move the session to another backend (it continues from a summary).     |
| `/new`                    | Start another session.                                                 |
| `/resume [id]`            | Resume a saved session of this directory.                              |
| `/feature`                | Open or fold the active feature's tasks.                               |
| `/review [ref]`           | Review the working tree now, against `HEAD` or a git ref.              |
| `/undo-correction`        | Undo the latest escalated review correction.                           |
| `/compact [instructions]` | Summarize the older history now.                                       |
| `/exit`                   | Quit.                                                                  |

### Keys

| Key       | Effect                                                               |
| --------- | -------------------------------------------------------------------- |
| Enter     | Send the prompt.                                                     |
| Up / Down | Prompt history; move in lists and questions.                         |
| Esc       | Interrupt the running turn; in a question or a list, deny or cancel. |
| Ctrl+C    | Interrupt the turn; with none running, clear the editor or quit.     |
| Ctrl+D    | Quit, on an empty editor.                                            |
| Ctrl+O    | Expand or fold every tool, subagent and verification card.           |
| Ctrl+T    | Open or fold the active feature's tasks.                             |
| Shift+Tab | Switch the permission mode between `normal` and `auto`.              |

### Permission modes

- `normal`: commands run in the sandbox without asking; what the sandbox cannot cover (leaving it, writing outside the working directory, deleting or publishing work) asks you.
- `auto`: what `normal` would ask goes to a classifier model, which allows or denies it; you are asked when it cannot decide.
- `yolo`: nothing is asked except the commands that always ask. Do not use it for work you do not trust.

Some commands are always refused (`rm -rf /`, `git reset --hard`, force pushes…) and some always ask (`rm -r`, `git push`, `npm publish`…), in every mode. Details: [sandbox and permissions](docs/sandbox.md).

## Desktop app

```bash
pnpm desktop
```

Open a folder, pick a backend, a model, a profile and a permission mode, and chat. Tool calls, approvals, subagents, reviews and the cost of each turn show in the conversation. More: [desktop](docs/desktop.md).

## Configuration

Everything lives in `~/.atelier/`, which the agent cannot write:

| File                   | What it holds                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------- |
| `profiles.json`        | Model, backend and thinking level per agent role ([profiles](docs/profiles.md)).                   |
| `permission-mode.json` | Default permission mode, written by `/mode default <mode>`.                                        |
| `sandbox.json`         | Extra writable paths and hidden paths for `bash` ([sandbox](docs/sandbox.md#configuration-files)). |
| `sessions/`            | Saved sessions ([saved sessions](docs/sessions.md)).                                               |

A project can add `.atelier/profile.json` and `.atelier/sandbox.json`. The agent reads `AGENTS.md` (or `CLAUDE.md`) from the working directory and its parents, and `~/.agents/AGENTS.md`.

| Variable              | Effect                                   |
| --------------------- | ---------------------------------------- |
| `ATELIER_TUI=off`     | Line-by-line session instead of the TUI. |
| `ATELIER_REVIEW=off`  | Same as `--no-review`.                   |
| `ATELIER_SANDBOX=off` | Same as `--no-sandbox`.                  |
| `ATELIER_MEMORY=off`  | No long-term memory.                     |

## Inspiration

Atelier is inspired by [gentle-shell](https://github.com/Gentleman-Programming/gentle-shell) and [gentle-ai](https://github.com/Gentleman-Programming/gentle-ai), by Gentleman Programming, and follows their way of working:
- **Organic Driven Development (ODD)**: explore before changing, size the task, take the small path inline, and keep large work in a feature document with the user's requests verbatim, tests first and reviewable commits.
- **Receipt-Driven Development (RDD)**: declare the risk of every change, review high-risk work through independent lenses with a refuter and one bounded correction, and leave a receipt.
- The independent verifier and the destructive command guard follow gentle-shell's.

Atelier brings these ideas into its own core, as code instead of prompt prose, so they work the same on every backend. It also builds on [pi](https://github.com/earendil-works/pi) (its TUI library) and remembers with [Engram](https://github.com/Gentleman-Programming/engram).

## Documentation

- [CLI reference](docs/cli.md): every option, the output, the TUI in detail.
- [Desktop app](docs/desktop.md)
- [How Atelier works](docs/architecture.md): events, tools, backends, subagents, ODD, memory, compaction.
- [Review and verification](docs/review.md)
- [Agent profiles and session settings](docs/profiles.md)
- [Saved sessions](docs/sessions.md)
- [Sandbox and permissions](docs/sandbox.md)
- [Development](docs/development.md): packages, checks, measurement scripts.

## License

MIT, see [LICENSE](LICENSE). Third-party software Atelier builds on is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
