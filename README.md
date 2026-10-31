# Atelier

Coding-agent orchestrator with two first-class clients, a terminal UI and a desktop app, on top of one headless core.
- Runs on your Claude subscription through Claude Code, or on its own loop with an Anthropic API key.
- Delegates to subagents, keeps large work in feature documents following Organic Driven Development (ODD), and remembers across sessions with [Engram](https://github.com/Gentleman-Programming/engram) when it is installed, your prompts included (the credentials it recognizes are masked, best effort; see [memory](docs/architecture.md); `ATELIER_MEMORY_PROMPTS=off` or the [settings](docs/cli.md#settings) keep them out).
- Reviews the changes of every turn with receipts and verifies high-risk ones independently.
- Runs `bash` inside the macOS sandbox and asks before anything the sandbox cannot make safe.

## Requirements

- Node 22.19+ and pnpm. TypeScript runs natively; there is no build step.
- For the default `claude-code` backend: a Claude subscription. Atelier brings its own Claude Code; sign in once with `atelier login account anthropic` (or `/login` in a session), which runs Claude Code's sign-in in the browser. It shares the login of any Claude Code on this machine, so if `claude` is already logged in there is nothing to do.
- For the `openai-codex` backend: a ChatGPT subscription (Plus, Pro or a business plan). Sign in with `atelier login account openai-codex` (OpenAI Codex, the Codex CLI's sign-in, in the browser or with a device code) or `atelier login account openai-chatgpt` (Sign in with ChatGPT, the way OpenAI offers other agents); the backend uses the first when both are there. OpenAI may refuse the Codex sign-in at any time, and using it from another program may go against OpenAI's terms. Either counts against your plan's limits.
- For the `anthropic-api` backend: an Anthropic API key with credit. `atelier login api-key anthropic` asks for it without showing it and keeps it in `~/.atelier/auth.json`. `ANTHROPIC_API_KEY` set for a single command takes priority, and a key stored in the macOS Keychain (service `atelier-anthropic`) by earlier versions still works. Do not export `ANTHROPIC_API_KEY` in your shell profile: Claude Code would then bill the API instead of your subscription.
- For the `opencode-go` backend: an [OpenCode Go](https://opencode.ai/docs/go) plan. `atelier login api-key opencode-go` keeps its key in `~/.atelier/auth.json`; `OPENCODE_API_KEY` set for a command takes priority. Then `atelier --backend opencode-go` runs `minimax-m3`, or `--model` another of its models (`/model` lists them).
- Optional: [Engram](https://github.com/Gentleman-Programming/engram) 3.4.0 or newer for long-term memory.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/alvag/atelier/main/install.sh | sh
```

It needs git, Node 22.19+ and pnpm. It clones the newest release (`vX.Y.Z`) into `~/.atelier/app`, installs what the CLI needs and puts an `atelier` command in `~/.local/bin` (it tells you if that folder is not on your `PATH`). To install the desktop app too (Electron, about 200 MB), pass `--desktop`:

```bash
curl -fsSL https://raw.githubusercontent.com/alvag/atelier/main/install.sh | sh -s -- --desktop
```

| Command                 | Effect                                                                                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `atelier update`        | Move to the newest release and reinstall its dependencies (and rebuild the desktop if it is installed).                                                                                 |
| `atelier update v0.1.0` | Move to that release, newer or older.                                                                                                                                                   |
| `atelier update --main` | Move to the latest `main` (`atelier --version` shows it); `atelier update` goes back to a release.                                                                                      |
| `atelier desktop`       | Open the desktop app of the same version; the first time it installs and builds it.                                                                                                     |
| `atelier mcp list`      | Connect to the MCP servers of `~/.atelier/mcp.json` and show their state, tools and errors.                                                                                             |
| `atelier mcp login <s>` | Sign a remote MCP server in with OAuth, in the browser; `atelier mcp logout <s>` signs it out.                                                                                          |
| `atelier login`         | Sign in with an account or an API key, choosing the provider; shows each one's state.                                                                                                   |
| `atelier logout`        | Sign out of what is signed in: a stored API key, an OpenAI sign-in, or the Claude Code login.                                                                                           |
| `atelier stats`         | Show what the saved sessions cost: totals and by day, project, model, phase and role (`--since 7d`, `--json`).                                                                          |
| `atelier models`        | Show the models `/model` offers, newest first, with their names, windows and whether they take images; `--refresh` asks models.dev and the providers you are signed in to for new ones. |

`atelier update` only touches a copy installed this way, and refuses one with local changes. To work on Atelier itself, clone the repository and run it with `pnpm install` and `pnpm atelier` (see [development](docs/development.md)).

## Usage

```bash
atelier                                                          # interactive session in the current directory
atelier "add email validation to src/user.ts and run the tests"   # one turn, then exit
atelier --cwd ~/code/my-app                                      # work on another directory
atelier --continue                                               # resume the newest session of the directory
```

The interactive session runs full screen: a session bar stays fixed at the top, the transcript scrolls below it (mouse wheel, PageUp/PageDown), and the editor and an activity footer (mode, sandbox, phase, feature task and background jobs with unread notices) stay at the bottom, with footer items in their configured order. There is no repeated header or version; on exit only the transcript is left in the terminal. `--no-fullscreen` keeps the previous header and footer, with no top bar. It shows your prompts and the editor on a subtle background after `›`, as Codex does, and the agent's text as Markdown, with code blocks colored by language. What the session loaded (instructions, skills, memory) and its cost are in `/status` and the status line, not in the transcript; `/stats` breaks the cost down by model, phase and role. Text selected with the mouse is copied to the clipboard.

Give the agent a screenshot's path to inspect it with `read`: PNG, JPEG, GIF and WebP are supported on image-capable models through Anthropic Messages, Chat Completions, OpenAI Responses and Claude Code. The transcript shows the image's dimensions and type; the model receives its pixels. After a switch to a model without image support, its input contains an explicit omission notice for each historical image. Images are resized within decoded-pixel and encoded-size limits, and transparency is preserved. In Messages, Chat Completions and Responses, unmeasured images alone do not trigger threshold compaction. In the TUI, paste an image file's path to attach it as `[Image #n]`; delete its marker to remove it. On macOS, Ctrl+V attaches an image copied to the clipboard the same way (your terminal's text paste still pastes text). Opening a question cancels pending clipboard attachments and says once to paste them again; Enter during preparation names the source being read. Image-only prompts work too. Failed sends keep the draft, and images cannot be queued. RPC clients can also include images with a prompt. Resumed transcripts show `[Image #n]` for earlier prompt attachments. Saved backend history keeps prompt images; summary-only handoffs warn that they were not carried over. See [image input](docs/images.md).

The fullscreen status bar summarizes the directory, branch, changed-file count (`±3`), model, level and profile on the left, with context and cost on the right; it shortens the path, then the branch, to keep the right side visible. If a reported changed file has a Git filter (such as Git LFS), the counter is hidden rather than showing a potentially false count. The context gauge shows how full the context is, as a share of the model's window: `ctx ▰▱▱▱▱▱▱▱ 11% · 1M`. It turns yellow past 70% and red past 90% of the point where the session compacts, reads `?` right after a compaction until the next answer measures it, and a warning says once when the context reaches 90% of that point. Atelier compacts `anthropic-api` and `opencode-go` sessions when the context passes the window minus 16,384 tokens, and `openai-codex` sessions when it passes the window minus 32,000 for the answer and 16,384 more (Claude Code compacts on its own). With a 1M-token model, every request of a long session can carry close to a million tokens and each turn costs more: `ATELIER_COMPACT_AT` sets a lower point ([compaction](docs/architecture.md)).

The agent can run a command in the background (a CI run, a build, another agent it waits for) and keep working; when the command ends, the agent gets a notice with its next tool result, or in a turn of its own when none is running. The transcript shows when each job starts and ends and the status line how many run; closing the session stops them all, and `atelier run "..."` waits for them before it exits (Ctrl+C stops them). It can also send an explorer or a worker to the background and get its report when it finishes; a worker writes in a git worktree of its own and its changes come back as a patch the agent applies. See [background jobs](docs/cli.md).

| Option                             | Effect                                                                                                                                                                       |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--mode <mode>`                    | Permission mode: `normal` (default), `auto` or `yolo` (see below).                                                                                                           |
| `--backend <name>`                 | `claude-code` (default, Claude subscription), `anthropic-api` (billed to the API key), `opencode-go` (OpenCode Go plan) or `openai-codex` (ChatGPT subscription).            |
| `--model <name>`                   | Model to use (default: `opus` on `claude-code`, whatever model it stands for now, `claude-sonnet-5-5` on `anthropic-api`); `openai-codex/gpt-6-luna` also picks the backend. |
| `--profile <name>`                 | Agent profile for this session (see [profiles](docs/profiles.md)).                                                                                                           |
| `--cwd <dir>`                      | Working directory (default: current directory).                                                                                                                              |
| `--continue`                       | Resume the newest saved session of the working directory.                                                                                                                    |
| `--resume <id>`                    | Resume that saved session of the working directory.                                                                                                                          |
| `--no-session`                     | Do not save this session.                                                                                                                                                    |
| `--no-fullscreen`                  | Run the interactive session in the terminal's main screen, under what was there.                                                                                             |
| `--no-review`                      | Do not review or verify changes.                                                                                                                                             |
| `--no-sandbox`                     | Run `bash` without the macOS sandbox.                                                                                                                                        |
| `-h`, `--help` / `-v`, `--version` | Help and version.                                                                                                                                                            |

Exit codes: `0` ok, `1` failed turn, `2` usage error, `130` interrupted.

### Commands

| Command                     | Effect                                                                                                                                                                                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/model [provider/model]`   | Change the model, of any provider you are signed in to; without a name, pick from a list, newest first, which shows the selected model's name, window and whether it takes images. Another provider's moves the session there (it continues from a summary). |
| `/effort [level]`           | Change the thinking level (`off`, `minimal`, `low` … `max`).                                                                                                                                                                                                 |
| `/profile [name]`           | Change the agent profile.                                                                                                                                                                                                                                    |
| `/mode [mode]`              | Change the permission mode; `/mode default <mode>` saves the default.                                                                                                                                                                                        |
| `/new`                      | Start another session.                                                                                                                                                                                                                                       |
| `/resume [id]`              | Resume a saved session of this directory.                                                                                                                                                                                                                    |
| `/rename <name>`            | Name this session; the terminal's title shows it.                                                                                                                                                                                                            |
| `/feature`                  | Open or fold the active feature's tasks.                                                                                                                                                                                                                     |
| `/mcp [login\|logout <s>]`  | Show the session's MCP servers, or sign one in or out.                                                                                                                                                                                                       |
| `/login`, `/logout`         | Sign in or out with an account or an API key, as `atelier login` does.                                                                                                                                                                                       |
| `/permissions [remove <n>]` | List the commands and folders you allowed, or remove one.                                                                                                                                                                                                    |
| `/review [ref]`             | Review the working tree now, against `HEAD` or a git ref.                                                                                                                                                                                                    |
| `/undo-correction`          | Undo the latest escalated review correction.                                                                                                                                                                                                                 |
| `/compact [instructions]`   | Summarize the older history now.                                                                                                                                                                                                                             |
| `/status`                   | Show the model, sandbox, instructions, skills, memory and cost.                                                                                                                                                                                              |
| `/stats [project]`          | Show this session's cost by model and role, or the directory's.                                                                                                                                                                                              |
| `/exit`                     | Quit.                                                                                                                                                                                                                                                        |

### Keys

| Key               | Effect                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| Enter             | Send the prompt; while a turn runs, queue it as a steer, which the agent gets with its next tool result.       |
| Alt+Enter         | While a turn runs, queue a follow-up, which runs as a turn of its own after it.                                |
| Shift+Up          | Take the queued messages back into the editor, to edit them and send them again (also Alt+Up).                 |
| Esc               | Cancel an open question or list; otherwise cancel a `!` command, clear a `!` draft, or interrupt the turn.     |
| Up / Down         | Prompt history; move in lists and questions.                                                                   |
| Ctrl+C            | Interrupt the turn; with none running, clear the editor or quit; in a question or a list, as Esc.              |
| Ctrl+D            | Quit, on an empty editor; in a question or a list, as Esc.                                                     |
| Ctrl+O            | Expand or fold the blocks of calls and every card, or the whole command of an approval.                        |
| Ctrl+R            | Open or fold the model's thinking, which folds once the model moves on (full screen, a click opens one block). |
| Ctrl+T            | Open or fold the active feature's tasks.                                                                       |
| Shift+Tab         | Switch the permission mode between `normal` and `auto`.                                                        |
| PageUp / PageDown | Scroll the transcript (also the mouse wheel); Ctrl+End goes back to the latest output.                         |

### Shell commands

Type `!` and a command to run it yourself, outside the agent and its sandbox, even while a model turn runs (but not while a slash command is still running); `!!` runs it too but keeps the result out of the model's context:

```text
!git status --short
!!cat .env.local
```

The output shows in the transcript and the result is saved with the session, so it is there when you resume it. Resuming keeps the answer text before and after a shell result. `!!` is not a privacy mode: the command and its output are stored locally in the session file, and only the model does not get them. With no question open, Esc cancels a running command. The next prompt waits for its completed result to be saved; `/new`, `/resume` and quitting remain available and discard a prompt still waiting for that save. Commands have no terminal, so `sudo` or anything else that asks for a password or opens an editor fails. After the shell exits, output capture ends within 250 ms even if a background process keeps running; later output is not shown or saved. See [shell commands you run](docs/cli.md).

While a question or a list is open, the editor is hidden and keys go to it, Ctrl+C and Ctrl+D included: they close it without interrupting the turn or quitting. Esc closes the question or list first (denying an approval), without cancelling a running shell command or clearing the hidden draft. Approvals and other guarded questions ignore Esc during their first 400 ms; press it again after that brief wait. Your draft comes back to the editor, unsent, when it closes.

### Automatic review

Commits made during a turn, including amendments, are part of its automatic review. A branch switch alone does not review the other branch's history; subsequent work is measured from where the switch landed. Creating or switching to a branch at a turn-owned commit keeps its earlier changes in the review, including after an amend. If a rewritten history cannot be attributed safely, Atelier reports that review is unavailable and explains why instead of silently skipping it. See [review and verification](docs/review.md).

### Structured questions

The agent can offer choices with `ask_user`, one question or a batch of up to four. In the TUI, use Up/Down to move the `❯` cursor and Enter to confirm, or press an option's number; in a batch, Left/Right move among the questions' tabs, keeping your answers, and a last review sends them with `Submit answers` once every question has one; a question that takes several answers shows `[ ]` boxes that Space, Enter or a number checks, and its `Next →` or `Submit` row goes on, with none checked allowed; Esc, Ctrl+C or Ctrl+D cancels the whole batch. When the agent gives options a preview, such as a code snippet, the TUI shows the one of the option under the cursor in a box beside the options or under them, and line mode prints each below its option. In a line-by-line run, type a choice's number, or for a question that takes several, numbers separated by commas (`1,3`) or `0` for none. In the desktop, fill the card and click `Send answers`, or `Cancel`. The recommended option comes first, tagged `Recommended` in the TUI and `(Recommended)` elsewhere, but Enter never chooses it for you. `Type something…` in the TUI (`Other...` elsewhere) lets you write your own answer (up to 2000 characters); `/cancel` cancels the whole batch in line mode. Only you can answer, even in `yolo`. Without an interactive terminal, the tool returns unavailable instead of guessing or waiting. See [structured questions](docs/ask-user.md).

### Permission modes

- `normal`: commands run in the sandbox without asking; what the sandbox cannot cover (leaving it, writing outside the working directory, deleting or publishing work) asks you.
- `auto`: what `normal` would ask goes to a classifier model, which allows or denies it; you are asked when it cannot decide.
- `yolo`: nothing is asked except the commands that always ask. Do not use it for work you do not trust.

Some commands are always refused (`rm -rf /`, `git reset --hard`, force pushes…) and some always ask (`rm -r`, `git push`, `npm publish`…), in every mode. Details: [sandbox and permissions](docs/sandbox.md).

## Desktop app

```bash
atelier desktop
```

The first time it installs Electron (about 200 MB) and builds the app, unless `install.sh --desktop` already did. Open a folder, pick a backend, a model, a profile and a permission mode, and chat. Tool calls, approvals, subagents, reviews and the cost of each turn show in the conversation. More: [desktop](docs/desktop.md).

## Configuration

Everything lives in `~/.atelier/`, which the agent cannot write:

| File                       | What it holds                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `profiles.json`            | Model, backend and thinking level per agent role ([profiles](docs/profiles.md)).                                                                        |
| `permission-mode.json`     | Default permission mode, written by `/mode default <mode>`.                                                                                             |
| `permissions.json`         | Commands and folders you allowed always ([rules](docs/sandbox.md#rules-you-allowed)).                                                                   |
| `project-permissions.json` | Commands that run a project's code (`npm install`, `make`, ...) you allowed always in one project.                                                      |
| `settings.json`            | Full screen or not, thinking folded, the status line items, the notifications and whether your prompts go to memory ([settings](docs/cli.md#settings)). |
| `sandbox.json`             | Extra writable paths and hidden paths for `bash` ([sandbox](docs/sandbox.md#configuration-files)).                                                      |
| `mcp.json`                 | MCP servers the agent can use, in the `mcpServers` format of Claude Code ([MCP](docs/mcp.md)).                                                          |
| `mcp-auth.json`            | OAuth sign-ins of MCP servers (`0600`), written by `atelier mcp login`.                                                                                 |
| `auth.json`                | API keys and OpenAI sign-ins stored by `atelier login` (`0600`); the agent cannot read it.                                                              |
| `device-id`                | This installation's id for Sign in with ChatGPT (`0600`).                                                                                               |
| `sessions/`                | Saved sessions ([saved sessions](docs/sessions.md)).                                                                                                    |

A project can add `.atelier/profile.json` and `.atelier/sandbox.json`. The agent reads `AGENTS.md` (or `CLAUDE.md`) from the working directory and its parents, and `~/.agents/AGENTS.md`. It also lists the skills in `.agents/skills/` (from the working directory up to the repository root) and in `~/.agents/skills/`, each a folder with a `SKILL.md`, and reads one when a task matches it; the first turn says which skills were loaded.

| Variable                     | Effect                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `ATELIER_TUI=off`            | Line-by-line session instead of the TUI.                                                                                                |
| `ATELIER_REVIEW=off`         | Same as `--no-review`.                                                                                                                  |
| `ATELIER_SANDBOX=off`        | Same as `--no-sandbox`.                                                                                                                 |
| `ATELIER_COMPACT_AT=<n>`     | Context tokens at which Atelier compacts a session, below its default (the window minus 16,384, and 32,000 more on `openai-codex`).     |
| `ATELIER_MEMORY=off`         | No long-term memory.                                                                                                                    |
| `ATELIER_MEMORY_PROMPTS=off` | Your prompts are not saved to long-term memory.                                                                                         |
| `ATELIER_MCP=off`            | No MCP servers.                                                                                                                         |
| `ATELIER_LOGIN_CHECK=off`    | Do not check at start whether the backend has its login or key; the model catalog reads no credential either, and asks only models.dev. |
| `ATELIER_MODEL_REFRESH=off`  | Do not ask models.dev or the providers for new models ([model catalog](docs/models.md)).                                                |
| `ATELIER_OFFLINE=1`          | Same as `ATELIER_MODEL_REFRESH=off`.                                                                                                    |
| `ATELIER_CODEX_VARIANT`      | `legacy` or `chatgpt`: the OpenAI sign-in `openai-codex` uses, instead of the Codex one first and ChatGPT after.                        |
| `ATELIER_SCRATCH_SWEEP=off`  | No cleanup of the temporary directories that crashed sessions left ([temporary directories](docs/architecture.md)).                     |

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
- [Model catalog](docs/models.md): where the models `/model` offers come from, and what is sent where.
- [Saved sessions](docs/sessions.md)
- [Sandbox and permissions](docs/sandbox.md)
- [MCP servers](docs/mcp.md)
- [Development](docs/development.md): packages, checks, measurement scripts.

## License

MIT, see [LICENSE](LICENSE). Third-party software Atelier builds on is listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
