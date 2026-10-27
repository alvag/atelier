# Sample – Study

Sample feature document with an extra section before the task table and notes after it.
The project directory is not a git repository: tasks record "no commit" as evidence.

## Specs

- **S1** — User request, verbatim: "let's start the study, gather everything that may help us later".
- **S2** — Scope: the agent loop, providers and tools of each source project.
- **S3** — Confirm or discard each token hypothesis: stable prefix for the cache, lazy assets, bounded outputs.
- **S4** — Record each repository's license.
- **S5** — Method: a question list per repository and a findings ledger with `path:line` evidence.
- **S6** — Each document maps what it studied to the milestones, with what to take and what to avoid.
- **S7** — The studied repositories are read-only.
- **S8** — Documents are written in English; identifiers and paths stay as they are.

## Document template

1. **Identity** — repository, studied commit, license.
2. **Map** — main modules and entry points, with `path:line`.
3. **Ledger** — finding | kind (observation / inference / unknown) | evidence.

## Tasks

| ID | Specs | Ruta | Entregable | Commit |
|---|---|---|---|---|
| T1 | S1–S8 | gentle-ai-worker | `docs/study/agent.md` | no commit — done |
| T2 | S1–S8 | gentle-ai-worker | `docs/study/shell.md` | no commit — done |
| T3 | S1–S8 | gentle-ai-worker | `docs/study/desktop.md` | no commit — done |
| T7 | S1–S6, S8 | inline | `docs/study/README.md` (synthesis and license table) | no commit — done |

### Questions per task

- **T1 agent**: provider abstraction, streaming, tool call normalization, prompt caching.
- **T2 shell**: how it extends the agent, lazy assets, subagents.
- **T3 desktop**: main/renderer split, session handling, what UI ideas to reuse.

## Log

- **L1** — User: "let's start the study, gather everything that may help us later"
- **L2** — Decision: three independent tasks, one per repository, with disjoint edit surfaces; synthesis inline.
