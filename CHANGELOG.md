# Changelog

Each release of Atelier, newest first. A release is the `vX.Y.Z` tag on `main`; its GitHub release carries the same notes.

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
