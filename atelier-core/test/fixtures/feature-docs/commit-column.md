# Sample – Subagents

Sample feature document with the older `Commit` column instead of `Estado`. The approved design is `docs/sample-design.md`: workers read it whole.
Code on branch `feat/sample`, one commit per unit (≈400 lines at most).

## Specs

- **S1** — User request, verbatim: "yes, all six" (answer to "Do all six go, or do you want to change any?"; decisions from `docs/sample-design.md`: child session in the same process; two built-in definitions, `explorer` and `worker`; report capped at 8 000 characters with a marker).
- **S2** — Roadmap criterion, verbatim: "the agent delegates an exploration to a subagent and only the bounded report enters the parent's context".
- **S3** — Core: `task({ agent, prompt })` implemented by `Session`; the child gets its definition's tools, never `task`; a child that fails → error `tool_result` with the reason.
- **S4** — Events and control: child events carry `parentCallId` and `agent`; interrupting and closing propagate.
- **S5** — Clients: the CLI indents the child's lines; the desktop shows a collapsible block per subagent.
- **S6** — Done criteria 1–5. No automated test uses the network.

## Tasks

| ID | Specs | Ruta | Entregable | Commit |
|---|---|---|---|---|
| U1 | S1, S3 | inline | Definitions, `task` in `Session`, bounded report, tests | `aaaa111` — done (393 lines) |
| U2 | S4 | inline | `parentCallId`/`agent`, interruption and closing | `bbbb222` — done (309 lines) |
| U3 | S5 | inline | Nested CLI and desktop rendering | `cccc333` — done |
| U4 | S2, S6 | inline | Real run, measurement, README | `dddd444` + `eeee555` (fix) — done |

## Delivery slices

Each unit is a reviewable commit of about 400 lines or fewer; a larger one is split.

## Log

- **L1** — "yes, all six" (answer to "Do all six go, or do you want to change any?").
- **L2** — U1: `task` is a `ToolDefinition` whose `execute` runs the child; the report is the text after the child's last tool.
- **L3** — U2: interruption reaches the child only through the tool's abort signal; calling it directly as well interrupted it twice.
