# MCP servers

Atelier connects to the [Model Context Protocol](https://modelcontextprotocol.io) servers you configure, over stdio or streamable HTTP, and lets the main agent use their tools.

## Configure servers

Servers are configured only by the user, in `~/.atelier/mcp.json`, which the agent cannot write. There is no project configuration. The format is the one of Claude Code and Pi, so an existing `mcpServers` entry can be copied as it is:

```json
{
	"mcpServers": {
		"filesystem": {
			"command": "npx",
			"args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
		},
		"docs": {
			"url": "https://example.com/mcp",
			"headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
			"description": "Search and read the product documentation"
		}
	}
}
```

- Stdio servers use `command` (one executable, not a shell command), `args`, `env` and `cwd`. A relative `cwd` resolves against the session's directory; a leading `~/` in `command`, an argument or `cwd` names the home directory.
- HTTP servers use `url` and `headers`, over streamable HTTP. SSE is refused: servers that document an SSE endpoint usually also serve streamable HTTP, often at `/mcp` instead of `/sse`.
- `type` is optional: `command` selects stdio and `url` selects HTTP. When present it must be `stdio`, `http` or `streamable-http`.
- `enabled: false` keeps the entry without connecting to it.
- `timeout` is the time a request may take, in seconds (60 by default).
- `description` says in a sentence what the server offers.
- Values of `env` and `headers` may name environment variables as `${NAME}`. An entry that names a variable that is not set is invalid.
- Server names may contain only letters, digits, `_` and `-`; names that differ only in `-` and `_` are the same server, and the second one is refused.
- An invalid entry, or a file that cannot be read, is reported and skipped without preventing the other servers from connecting. A file that is not valid JSON is reported with the line and column of the error, never with an excerpt of the file.

## How the agent uses them

The agent never sees the servers' tools declared one by one: that list would change as servers connect and break the prompt cache, and it would differ between backends. It has two fixed tools instead, with the same behavior on `claude-code` and `anthropic-api`:
- `mcp_search` (`query`, optional `server`, optional `limit`, 1 to 20, 5 by default) finds tools by the words of their name, their description and their server's name, best match first; `*` lists them all. Each match comes as `server/tool — description` and `input: <JSON schema>`. It waits for servers that are still connecting, and names the ones that are not reachable with their state and error.
- `mcp_call` (`server`, `tool`, optional `arguments`) runs a tool. The model reads the text of the result, or its structured content as JSON when it has no content. Images, audio and binary resources are saved to the session's scratch directory and the model reads `[image image/png, <n> bytes, saved to <path>]`; a resource link reads `[resource link: <uri>]`. A text over 20,000 characters reaches the model with its middle cut out around a `…<n> chars truncated…` marker, followed by `The full result is in <path>; read it with read.`: the whole text is in a file of the scratch directory, deleted when the session closes, and `tool_call_finished` says `truncated: true` with that `fullOutputPath`. A result the server marks as an error, or a failed call (`MCP call failed: <reason>`), comes back as a failed tool call. Its line in a client is `server › tool`.

Both tools exist only when at least one server is enabled. The system prompt then lists the servers, from the configuration only, so it does not change during the session:

```
MCP servers the user configured. Their tools are not declared: find them with mcp_search and run them with mcp_call.
- docs: Search and read the product documentation
- filesystem: no description yet; mcp_search lists its tools
```

A server without `description` that sends instructions when it connects has the first line of them given once, before the next prompt, in a `<mcp_servers>` block.

MCP calls do not ask for approval in `normal` or `yolo`. In `auto` the permission classifier judges each `mcp_call`, as it does a `bash` command outside the sandbox: it reads `server › tool <arguments>` as the action, and the tool's server, description and input schema. A denial refuses the call; when the classifier does not decide, the user is asked `Call this MCP tool?` with the same line (`approval_requested` with `tool: "mcp_call"`). `mcp_search` never asks. Servers run outside the sandbox, with the user's permissions. Only the main agent has MCP: subagents and the review roles never get these tools, whatever their definition says. `ATELIER_MCP=off` runs sessions without MCP servers.

## Connections

When a session starts, Atelier connects every enabled server in the background; the session does not wait for them. A server is `connecting`, `connected`, `failed` (with its error and, for a stdio server, the end of its stderr), `disabled` or `invalid` (an entry that could not be taken, with what is wrong). A server whose connection drops is shown as failed and reconnects on its next call. When a server announces that its tool list changed, Atelier reads it again.

Stdio servers start in their own process group, with Atelier's environment plus their `env`. Stopping one closes its stdin, sends SIGTERM to the group and, after two seconds at most, SIGKILL to the group, so servers launched through wrappers such as `npx` or `uvx` stop too. Every server is stopped when the session closes.

## See the servers' state

The first turn of a session says the state of its servers with the `mcp_status` event (`servers`, one `{ name, transport?, state, tools, description?, error?, stderr? }` each, and `problems`, what is wrong with the file itself), and later turns say it again only when it changed. The CLI and the TUI print the servers that are up as `mcp: docs (2 tools), fs (connecting)`, and warn on stderr about each failed server (`mcp: ctx failed: <first line of the error> (/mcp for details)`), each invalid entry (`mcp: bad is invalid: <what is wrong>`) and each problem of the file. Disabled servers are not printed.

`atelier mcp list` connects to every enabled server outside a session, prints its state, its tools, its error and the end of its stderr, each invalid entry and each problem of the file, and exits with 1 when an entry is invalid, the file has a problem or an enabled server is not connected. In a session, `/mcp` prints the same for the session's servers as they are now, without a turn, in the TUI and in the line-by-line CLI.

The desktop shows `MCP <connected>/<enabled>` in the status bar and opens the same details in a side panel when you click it.

Clients ask for the state at any time with the protocol command `session.mcp` (`sessionId`), answered with `{ servers, problems }` as `mcp_status` carries them, both empty for a session without MCP servers. The protocol is version 7 since this command and event.

## Sign in with OAuth

Remote servers that use OAuth, such as Atlassian's `https://mcp.atlassian.com/v1/mcp/authv2`, need no credentials in `mcp.json`:

```json
{
	"mcpServers": {
		"atlassian": { "url": "https://mcp.atlassian.com/v1/mcp/authv2" }
	}
}
```

When such a server answers that it needs authorization, its state is `needs_auth` and its error says `sign-in required: run atelier mcp login <name>`. Sign in with `atelier mcp login <name>` from a shell, `/mcp login <name>` in a session (TUI or line-by-line CLI), or the panel's `Sign in` button in the desktop; a session connects the server again once it is signed in. `atelier mcp logout <name>` and `/mcp logout <name>` sign out, and cancel a sign-in of that server still waiting for the browser, which then saves nothing. A sign-in stops at its timeout, or when the session closes, also while its first connection is still under way, and its loopback callback closes with it. Clients do it with the protocol commands `session.mcp_login` and `session.mcp_logout` (`sessionId`, `server`), answered with `{ servers, problems }` once done, or with the error `mcp_failed`; the core opens the browser itself. Signing in opens the authorization page in the browser and waits, up to five minutes, for it to come back to `http://127.0.0.1:<port>/callback`. Atelier finds the authorization server through the server's metadata, registers itself as `Atelier` when the server allows dynamic client registration, and keeps the client and the tokens in `~/.atelier/mcp-auth.json`, which only you can read and write (`0600`); a file found with wider permissions is set back to `0600` when it is read. Sessions use those tokens, and refresh them when they expire or the server refuses them; a session never opens the browser, so a server that wants a new sign-in shows `needs_auth` again. Credentials belong to a server name and URL. Signing out deletes them.

OAuth applies only to HTTP servers without an `Authorization` header. For a server that does not support dynamic client registration, configure a registered client:

```json
{
	"mcpServers": {
		"example": {
			"url": "https://mcp.example.com/mcp",
			"oauth": { "clientId": "my-client", "clientSecret": "${EXAMPLE_SECRET}", "callbackPort": 8765 }
		}
	}
}
```

`oauth` takes `clientId`, `clientSecret` (which may use `${NAME}`), `callbackPort` (the redirect URI is then `http://127.0.0.1:<port>/callback`, which must match the registered one; without it a free port is used, and the port of an earlier registration is preferred), `scope` (space-separated, for servers that do not advertise their scopes) and `clientName` (the name sent when registering).

### Secrets

Atelier never shows the values of `env` and `headers` or the `oauth.clientSecret`, written literally or taken from `${NAME}`, the values of the URL's query (`?key=...`), nor the OAuth tokens and client secrets of `mcp-auth.json`, also after they are replaced or deleted. Any of them that appears in an error, a server's stderr or a status, in a client, an event or a log, is replaced by `***`, and so is each word of them that looks like a token, eight characters or more with a digit or a symbol (the token of `Bearer <token>`). Every value is hidden, whatever its length: one of six characters or more wherever it appears, a shorter one where it stands as a word of its own, so that a value such as `a` or `1` does not blank those letters out of every message. What the servers send is filtered the same way: tool names and descriptions (in `mcp_search`, `mcp_status`, `/mcp` and `atelier mcp list`), instructions, and `mcp_call` results, the file of a long result included.
