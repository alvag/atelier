# Atelier

A pnpm monorepo: `atelier-core` (sessions, backends, tools, review), `atelier-cli` and `atelier-desktop` (Electron + React). Node runs the TypeScript sources directly; there is no build step for the core or the CLI.

## Conventions

- Code, comments, tests, identifiers, README, `docs/` and commit messages are in English. The README is for users (install, basic commands, keys, configuration); the reference lives in `docs/`. The repository is self-contained: no links to paths outside it. Design and measurement notes live outside this repo in `../docs/`, in Spanish, and are never linked from it.
- Commit messages follow Conventional Commits with a scope: `feat(core): ...`, `fix(cli): ...`, `fix(desktop): ...`, `test(cli): ...`, `docs: ...`. Imperative, lowercase after the colon, no trailing period.
- Match the surrounding code: tabs, the existing comment density, small named helpers over clever one-liners.

## Workflow

- Work on a new branch (`feat/...`, `fix/...`), never on `main`. The user merges into `main`; do not merge or push.
- Write the test first for a behavior change and watch it fail, then make it pass. Tests go in the same commit as the change, and they check observable effects through the public interface (events, CLI output, what the backend receives), not internal state.
- When you change a command, option, event or message, update the page of `docs/` that describes it, and the README when a user sees it, in the same commit.
- Run `pnpm check` (Biome, TypeScript for core/CLI and desktop, Vitest) before every commit. Fix formatting with `pnpm format`. Do not commit with failing checks.
- `pnpm-lock.yaml` belongs to pnpm: Biome skips it (`biome.json`), so commit it as `pnpm add` or `pnpm install` writes it, without formatting it.
- When the checks pass, commit your work on the branch before reporting the task done; leave nothing uncommitted.
- A release adds its section to `CHANGELOG.md` and publishes the same notes as its GitHub release (see `docs/development.md`, "Versioning").
- Keep each commit reviewable: one unit of behavior, about 400 changed lines at most.
- Wait for a condition in tests instead of a fixed delay (see the `until` helper in `atelier-cli/test/run.test.ts`).

## Boundaries

- Never edit the installed copy in `~/.atelier/app/`: it is the released Atelier that runs the agent. Changes are tried with `pnpm atelier` or `pnpm desktop` inside this repo.
- `bash` is not sandboxed: no commands outside this repo, no installs, and no network access unless the user asks for them.
