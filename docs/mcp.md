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
- An invalid entry, or a file that cannot be read, is reported and skipped without preventing the other servers from connecting.

### Secrets

Atelier never shows the values of `env` and `headers`, written literally or taken from `${NAME}`, nor the values of the URL's query (`?key=...`). Any of them that appears in an error, a server's stderr or a status, in a client, an event or a log, is replaced by `***`, and so is each word of them (the token of `Bearer <token>`). Values shorter than six characters are not hidden.
