# Changelog

Each release of Atelier, newest first. A release is the `vX.Y.Z` tag on `main`; its GitHub release carries the same notes.

## v0.6.0

Questions with several choices, background commands and subagents, images, a status bar and context gauge, and stricter protection of what the agent runs and fetches.

Terminal interface:
- A fixed status bar at the top of the full screen shows the directory, branch with the number of changed files, model, level and profile on the left, and the context and the session's cost on the right; the footer keeps the mode, sandbox, phase, task and `jobs` ([#142](https://github.com/alvag/atelier/pull/142), [#97](https://github.com/alvag/atelier/issues/97)).
- The context shows as a gauge, `ctx ▰▰▱▱▱▱▱▱ 23% · 200k`, yellow and then red as it nears the point where the session compacts, and `?` right after a compaction until a request measures it again. A warning says when the context nears that point. The backends now compact when the context passes the window minus 16,384 tokens instead of at 200,000 ([#121](https://github.com/alvag/atelier/pull/121), [#96](https://github.com/alvag/atelier/issues/96)). The `claude-code` backend reports its context too, so its `ctx` shows as well ([#112](https://github.com/alvag/atelier/pull/112), [#95](https://github.com/alvag/atelier/issues/95)).
- Memory searches, reads and saves show as two compact lines of their own, `🧠 search "session summary"` and `↳ ✓ 2 results`, and so does the summary that compaction saves ([#94](https://github.com/alvag/atelier/pull/94), [#92](https://github.com/alvag/atelier/issues/92); [#98](https://github.com/alvag/atelier/pull/98), [#93](https://github.com/alvag/atelier/issues/93)).
- `!command` in the editor runs a shell command yourself, outside Atelier's sandbox and without the model (for example a push you want to do by hand), with live output and Esc to cancel; its result goes to the agent with your next prompt. `!!command` keeps it out of the agent's context ([#192](https://github.com/alvag/atelier/pull/192), [#25](https://github.com/alvag/atelier/issues/25)).
- The terminal's agent row reports what the TUI is doing: the call that runs, the end of the turn, the error or the question that blocks it ([#118](https://github.com/alvag/atelier/pull/118), [#114](https://github.com/alvag/atelier/issues/114)).
- A prompt sent just as a background notice wakes a turn is no longer lost: it is queued as a steer, and a draft with images or a slash command goes back to the editor ([#190](https://github.com/alvag/atelier/pull/190), [#188](https://github.com/alvag/atelier/issues/188)).

Questions:
- The agent can ask you with `ask_user`: one to four questions, each with two to four options, one recommended, and always a `Type something…` answer. Only you answer it, also in `yolo`. The TUI, the line CLI and the desktop show it ([#120](https://github.com/alvag/atelier/pull/120), [#26](https://github.com/alvag/atelier/issues/26)).
- In the TUI a batch has tabs and a review screen before it is sent, a lighter layout, and its answers stay in the transcript, also when you resume the session ([#140](https://github.com/alvag/atelier/pull/140), [#134](https://github.com/alvag/atelier/issues/134), [#135](https://github.com/alvag/atelier/issues/135), [#136](https://github.com/alvag/atelier/issues/136); [#155](https://github.com/alvag/atelier/pull/155), [#146](https://github.com/alvag/atelier/issues/146)).
- A question can take several answers ([#148](https://github.com/alvag/atelier/pull/148), [#137](https://github.com/alvag/atelier/issues/137)), and an option can show a preview, such as a snippet or a layout, while you are on it ([#152](https://github.com/alvag/atelier/pull/152), [#138](https://github.com/alvag/atelier/issues/138)); the TUI and the line CLI ask for both.

Background work:
- The agent can run a shell command in the background with `bash_background`, list the running ones with `job_list` and stop them with `job_stop`. It keeps working, and a result wakes it when the command ends. Closing the session stops them ([#130](https://github.com/alvag/atelier/pull/130), [#111](https://github.com/alvag/atelier/issues/111)).
- `task` takes `background: true` to start an `explorer` or a `worker` without waiting for it, and its report comes back as a notice. A background `worker` edits in a git worktree of its own, with your dependencies linked and writes confined to it, and returns a patch that the agent applies with `git apply`. At most four run at once. The CLI, the TUI and the desktop show when they start and finish, and the footer counts them with the jobs; `atelier run` waits for them ([#150](https://github.com/alvag/atelier/pull/150), [#151](https://github.com/alvag/atelier/pull/151), [#39](https://github.com/alvag/atelier/issues/39)).
- The agent is told what to do while a task runs, to check a finished task's evidence once, and how to apply a worker's patch and when to run the checks ([#161](https://github.com/alvag/atelier/pull/161), [#154](https://github.com/alvag/atelier/issues/154)).

Agent and subagents:
- The main agent's turn no longer stops after 50 requests on `anthropic-api` and `openai-codex`: it runs until the model stops, you interrupt it or an error ends it. The review roles keep a limit of 50 requests ([#162](https://github.com/alvag/atelier/pull/162), [#160](https://github.com/alvag/atelier/issues/160)).
- The agent knows when to delegate: it reads up to about three files or 10k tokens itself, sends one `explorer` for more with paths and not file contents, and judges a question's breadth before reading it ([#113](https://github.com/alvag/atelier/pull/113), [#71](https://github.com/alvag/atelier/issues/71), [#72](https://github.com/alvag/atelier/issues/72); [#156](https://github.com/alvag/atelier/pull/156), [#124](https://github.com/alvag/atelier/issues/124)).
- `grep` takes `ignoreCase`, `literal`, `context` and `limit`, and ignores your ripgrep configuration, so what it returns does not depend on `RIPGREP_CONFIG_PATH` ([#106](https://github.com/alvag/atelier/pull/106), [#69](https://github.com/alvag/atelier/issues/69), [#70](https://github.com/alvag/atelier/issues/70)).
- Memory search takes `match_mode`: the agent retries an empty search once with `any` ([#116](https://github.com/alvag/atelier/pull/116), [#90](https://github.com/alvag/atelier/issues/90)).
- `web_search` shows the dates and authors of its results and reports Exa's rate limit even when it comes as a 200 ([#105](https://github.com/alvag/atelier/pull/105), [#88](https://github.com/alvag/atelier/issues/88), [#89](https://github.com/alvag/atelier/issues/89)).
- A `feature` result is bound to 2,000 lines or 50 KB, with a notice that says how to read the rest ([#115](https://github.com/alvag/atelier/pull/115), [#83](https://github.com/alvag/atelier/issues/83)).

Images:
- `read` returns an image to the model on every backend that takes images, and omits it with a notice for a model that does not. In the TUI you attach images by pasting their paths, which show as removable `[Image #n]` markers, and on macOS Ctrl+V attaches an image from the clipboard. A prompt takes up to 20 images and 20 MiB; RPC clients send them with `session.send.images`. Resumed sessions keep them ([#174](https://github.com/alvag/atelier/pull/174), [#32](https://github.com/alvag/atelier/issues/32), [#153](https://github.com/alvag/atelier/issues/153)).

Review:
- A branch too large for one review prompt is split by file into up to four parts instead of ending as `review unavailable: context_too_large`. After an automatic review that approves without a correction, the next round starts from the tree it saw, and shows as "since the last review" ([#177](https://github.com/alvag/atelier/pull/177), [#41](https://github.com/alvag/atelier/issues/41)).

Models:
- Thinking levels are sent on OpenCode Go: `minimax-m3` thinks by budget, models that reason on their own show `auto`, and when a level cannot be sent the footer says which one, `glm-5.3 medium not sent`. The deprecated `mimo-v2.5` models are gone from the list ([#104](https://github.com/alvag/atelier/pull/104), [#101](https://github.com/alvag/atelier/issues/101)).

Protection:
- Commands that run code from the repository (`npm`, `pnpm`, `make`, `cargo`, `pytest`, `./gradlew`…) offer `Allow always in this project` instead of a global rule. Those rules live in `~/.atelier/project-permissions.json`, `/permissions` shows them with their project, and a global rule saved earlier for such a command is skipped with a notice. A command nested more than 8 levels deep always asks, also in `yolo` ([#100](https://github.com/alvag/atelier/pull/100), [#78](https://github.com/alvag/atelier/issues/78), [#82](https://github.com/alvag/atelier/issues/82)).
- `web_fetch` reaches the public internet only: it refuses shared, reserved, multicast and documentation ranges, IPv4 addresses embedded in IPv6 ones, and `localhost`, `.localhost`, `.internal` and `.local` names, so tailnet and `.local` hosts no longer work with it ([#129](https://github.com/alvag/atelier/pull/129), [#128](https://github.com/alvag/atelier/issues/128)).
- MCP sign-in opens only `http` and `https` addresses in the browser ([#123](https://github.com/alvag/atelier/pull/123), [#64](https://github.com/alvag/atelier/issues/64)).

Fixes:
- A profile name has to be 1 to 64 letters, digits, `.`, `_` or `-`, and the notice says the rule and the invalid value ([#102](https://github.com/alvag/atelier/pull/102), [#74](https://github.com/alvag/atelier/issues/74)).
- Starting in a folder that was deleted says so in one line instead of printing a stack trace ([#108](https://github.com/alvag/atelier/pull/108), [#66](https://github.com/alvag/atelier/issues/66)).
- `grep` no longer takes a ripgrep warning for a match, and searches a dotfile you name even when the system `grep` is used ([#117](https://github.com/alvag/atelier/pull/117), [#109](https://github.com/alvag/atelier/issues/109), [#110](https://github.com/alvag/atelier/issues/110)).
- Reading the git protection settings takes one git process per file instead of three ([#125](https://github.com/alvag/atelier/pull/125), [#55](https://github.com/alvag/atelier/issues/55)).

Development:
- The sandbox probes, the git status and attribute-query tests no longer fail on a loaded machine, and a failing probe keeps its diagnostics ([#127](https://github.com/alvag/atelier/pull/127), [#63](https://github.com/alvag/atelier/issues/63); [#180](https://github.com/alvag/atelier/pull/180), [#157](https://github.com/alvag/atelier/issues/157); [#182](https://github.com/alvag/atelier/pull/182), [#179](https://github.com/alvag/atelier/issues/179)); a test pins that a sandboxed command cannot hard-link a file it cannot write ([#184](https://github.com/alvag/atelier/pull/184), [#79](https://github.com/alvag/atelier/issues/79)).

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
