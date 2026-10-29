# Changelog

Each release of Atelier, newest first. A release is the `vX.Y.Z` tag on `main`; its GitHub release carries the same notes.

## v0.5.0

Sign in to more providers, one model list across them with a catalog that keeps up, and tighter protection of credentials and git state.

Providers and models:
- `/login` and `atelier login` sign in to Anthropic (the Claude Code account, or an API key) ([#14](https://github.com/alvag/atelier/pull/14)), to OpenCode Go with an API key, whose models run on the Messages API or Chat Completions ([#15](https://github.com/alvag/atelier/pull/15)), and to ChatGPT for Codex, legacy or Sign in with ChatGPT, through the new `openai-codex` backend ([#16](https://github.com/alvag/atelier/pull/16)). `/logout` signs out; the start warns when the session's backend is not signed in, and the new secrets are masked like the rest.
- One `/model` list across every provider you are signed in to, as `provider/model`: `/model ` completes it, `/model` and Enter opens a picker you can search, and a model of another provider moves the session there with a summary of the conversation. `/backend` is gone; `--model` takes `provider/model`, and `--backend` and profiles keep working ([#18](https://github.com/alvag/atelier/pull/18)).
- A model catalog keeps the lists current: each signed-in provider's own list, with names, context windows, prices, reasoning and images from models.dev, cached in `~/.atelier/models.json` and refreshed in the background without slowing the start. `atelier models [--refresh]` shows where each model comes from; `ATELIER_MODEL_REFRESH=off` or `ATELIER_OFFLINE=1` keeps it off the network ([#56](https://github.com/alvag/atelier/pull/56), [#22](https://github.com/alvag/atelier/issues/22)).
- Claude Code's models are listed by their versioned names (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-fable-5-1`…), exactly the ones your subscription offers, and every provider's list goes newest first. The aliases (`opus`, `sonnet`, `fable`…) still work when typed, and a versioned model an alias stands for is sent as that alias, so it keeps the 1M context window. Under the `/model` picker, the selected model's name, context window and whether it takes images; `atelier models` shows the same ([#60](https://github.com/alvag/atelier/pull/60), [#59](https://github.com/alvag/atelier/issues/59)).

Terminal interface:
- Tool cards show their state in color, a diff with line numbers, and a background of their own ([#17](https://github.com/alvag/atelier/pull/17)).
- Each stretch of thinking folds once the model moves on ([#6](https://github.com/alvag/atelier/pull/6)).
- `/stats` shows the saved sessions' costs inside a session ([#9](https://github.com/alvag/atelier/pull/9)).
- An open question takes every key; Ctrl+C or Ctrl+D close it as Esc does, and Shift+Up takes the queue back ([#12](https://github.com/alvag/atelier/pull/12), [#13](https://github.com/alvag/atelier/pull/13)).

Agent:
- The agent writes to you in your language ([#11](https://github.com/alvag/atelier/pull/11)) and knows the outcome of its last review ([#7](https://github.com/alvag/atelier/pull/7)).

Protection:
- The agent can no longer read or write other tools' credential files: `~/.codex/auth.json`, OpenCode's `auth.json`, `~/.netrc` and git's credential stores ([#19](https://github.com/alvag/atelier/pull/19)).
- A `.git` below the working folder is git state: `bash`, `write` and `edit` refuse to create, replace or write inside one, also for commands a saved rule covers. `git init`, `git clone` or `git worktree add` inside the project now ask first ([#57](https://github.com/alvag/atelier/pull/57), [#43](https://github.com/alvag/atelier/issues/43)).

Fixes:
- `edit` and `write` launch about three times fewer git processes per call ([#54](https://github.com/alvag/atelier/pull/54), [#23](https://github.com/alvag/atelier/issues/23)).
- The `auth.json` lock waits out a transient read error instead of taking a live process's lock, and no longer spins; a Chat Completions answer cut mid-stream says so ([#21](https://github.com/alvag/atelier/pull/21), [#24](https://github.com/alvag/atelier/issues/24)).
- A turn reads where it started before the agent's first command runs, so a review no longer misses commits made early in the turn; an interrupt still stops the turn at once ([#61](https://github.com/alvag/atelier/pull/61), [#52](https://github.com/alvag/atelier/issues/52)).
- Temporary folders that dead sessions leave behind are cleaned up ([#5](https://github.com/alvag/atelier/pull/5)); follow-ups to the prompt secret masks ([#8](https://github.com/alvag/atelier/pull/8)); `mcp-auth.json`, an empty status line and the git branch item ([#3](https://github.com/alvag/atelier/pull/3)); `mcp_call` files go to a scratch folder of their own ([#10](https://github.com/alvag/atelier/pull/10)).

Development:
- `pnpm check` holds up under heavy machine load ([#20](https://github.com/alvag/atelier/pull/20), [#61](https://github.com/alvag/atelier/pull/61)), and a run inside a sandbox says at its end which sandbox tests it skipped ([#51](https://github.com/alvag/atelier/issues/51)); a readability pass on the TUI keys, skills and the `/model` list ([#58](https://github.com/alvag/atelier/pull/58)).

## v0.4.0

Queued messages, remembered permissions, a clearer conversation, a cost panel and notifications.
- Queued messages: while a turn runs, Enter sends a steer, which the agent gets with its next tool result, and Alt+Enter queues a follow-up, which runs as its own turn once the turn ends. The queue shows above the editor, Alt+Up brings it back to the editor to edit it, and interrupting a turn gives it back. The desktop shows the queue above the composer, where each message can be edited or removed.
- Remembered permissions: an approval offers `Allow`, `Allow in this session`, `Allow always` and `Deny`, for commands outside the sandbox and for edits outside the working folder. A command a rule covers runs outside the sandbox at once, still kept away from git hooks and config, shell start-up files, secrets and `~/.atelier`. Rules never cover what the destructive-command guard asks about, commands that change their environment, or interpreters and launchers "always". `Allow always` rules are kept in `~/.atelier/permissions.json`, which the agent cannot write; `/permissions` lists and removes them.
- A clearer conversation in the terminal interface: the agent's text opens with `●`, and the calls between two of its texts fold into one line (`Ran 3 commands · read 1 file · edited 1 file`), with failures and what the sandbox blocked still in sight. While a call runs, it shows in one line. Ctrl+O or a click opens a block. The model's thinking shows dimmed and folds with Ctrl+R; `tui.hideThinking` starts it folded. The feature's progress lines left the conversation.
- `atelier stats` shows what the saved sessions cost: totals and a breakdown by day, project, model, phase and role, with `--since`, `--project`, `--by` and `--json`. A subscription's API-equivalent cost is shown apart from what was billed, and an unknown cost is never shown as `$0`. It only reads the sessions.
- Notifications: when a long turn ends or fails, or the session waits for an approval or the review question, Atelier notifies through the terminal (OSC 9 in iTerm2, Ghostty, WezTerm and kitty; the bell in Orca, which turns it into a notification), `osascript` on other macOS terminals or `notify-send` on Linux. Inside Herdr it leaves notifying to Herdr. `tui.notifications` sets it.

## v0.3.0

Skills, MCP servers, and a full-screen terminal interface.
- Agent Skills: Atelier finds skills in `~/.agents/skills/` and in `.agents/skills/` from the working folder up to the repository root, lists each one's name, description and path to the agent, and the agent reads its `SKILL.md` when a task calls for it. The session shows which skills it loaded and why any was left out.
- MCP servers: configure them in `~/.atelier/mcp.json` (the usual `mcpServers` format, over stdio or HTTP, with `${VAR}` values). The agent finds their tools with `mcp_search` and calls them with `mcp_call`; `auto` mode sends each call to the permission classifier. Remote servers can sign in with OAuth (`atelier mcp login <server>`), `atelier mcp list` and `/mcp` show each server's state, and secrets never reach the screen, the events or the logs. The protocol moves to version 7.
- The terminal interface runs full screen: a short header, the conversation with its own scrolling, and the input and status line fixed at the bottom; leaving it prints the conversation. `--no-fullscreen` keeps the previous mode.
- The status line shows the items you choose in `~/.atelier/settings.json`, now with the working folder and the git branch.
- A quieter conversation: the session's setup and costs moved to `/status`, each prompt is a shaded block, the input is a shaded band with a placeholder, blocks are spaced apart, each turn ends with the time, and code blocks are colored by language. Warnings and anything that lowers protection stay in sight.
- Inside a Herdr pane, the interface reports its state and the ODD task in progress to Herdr as the agent `atelier`.
- The review question asks only `Review this high-risk change?`, with `Review this change`, `Skip this time` and `Review all this session`.
- Approvals start on Allow and ignore keys for their first 400 ms; a long command shows its first line until Ctrl+O.
- `atelier update --main` follows the `main` branch between releases, and `atelier --version` says so.
- `atelier update` puts the previous dependencies back when an install fails, and `install.sh` removes its own clone when it is interrupted.

## v0.2.0

Install Atelier globally from GitHub and keep it up to date.
- `install.sh`: `curl -fsSL https://raw.githubusercontent.com/alvag/atelier/main/install.sh | sh` checks git, Node 22.19+ and pnpm, clones the newest release into `~/.atelier/app` and puts an `atelier` command in `~/.local/bin`. `--desktop` installs and builds the desktop app too.
- `atelier update [vX.Y.Z]` moves an installed copy to the newest release, or to the one given (older too), and reinstalls its dependencies. It refuses a development clone, local changes and unknown releases, and goes back if the install fails.
- `atelier desktop` opens the desktop app in the same version as the CLI; the first time it installs Electron and builds it.
- `update` and `desktop` are subcommands only as the first word; a quoted prompt that starts with them is still a prompt.
- To work on Atelier itself, the installed copy is the tool and a clone of the repository is the workpiece (see `docs/development.md`).

## v0.1.0

First public release.
- MIT license; third-party notices in `THIRD_PARTY_NOTICES.md`.
- The README is for users; the reference lives in `docs/`.
- One version for the repository and every package, printed by `atelier --version` and sent in the protocol's `hello`.
