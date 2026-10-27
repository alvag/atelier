# Development

Packages, checks, measurement scripts, and how to work on Atelier with Atelier.

## Packages

| Package            | Directory          | Status                                                                                                           |
| ------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `@atelier/core`    | `atelier-core/`    | Event contract, session, tools, subagents, protocol server; backends `claude-code` (M1) and `anthropic-api` (M3) |
| `@atelier/cli`     | `atelier-cli/`     | `atelier` command                                                                                                |
| `@atelier/desktop` | `atelier-desktop/` | Desktop chat app (M2)                                                                                            |

## Working on Atelier with Atelier

Changing Atelier with the Atelier you are changing breaks the tool in the middle of the work. Keep a stable copy as the tool and the repository as the workpiece:

```
atelier/          the workpiece: feat/* branches, where the agent edits
atelier-stable/   the tool: a worktree pinned to a stable-* tag, never edited
```

```bash
# once: pin the copy that works today
git tag -a stable-m8 -m "Stable Atelier"
git worktree add --detach ../atelier-stable stable-m8
pnpm -C ../atelier-stable install

# use it on the workpiece (or on any other project)
alias atelier-stable='node /path/to/atelier-stable/atelier-cli/src/main.ts'
atelier-stable --cwd /path/to/atelier
pnpm -C ../atelier-stable desktop   # the desktop starts the stable copy's own core
```

- `edit` and `write` ask for approval before changing or creating any file outside `--cwd`, and the question shows the path: do not approve a path inside `atelier-stable/` (`read` and `grep` can read it freely). The stable copy is protected by that question, not by a rule: `normal` and `auto` ask it, `yolo` does not. Do not use `yolo` when the workpiece is Atelier itself.
- To try a change for real, run the workpiece's CLI (`pnpm atelier` inside `atelier/`) in another terminal; the stable copy stays in charge of the work.
- Memory (Engram resolves the project from the working directory), review receipts (in the workpiece's `.git`) and the API key are shared on purpose.

Promote only what is verified: once a branch is merged into `main` with `pnpm check`, the desktop smoke and a real run green, tag it and move the copy. To go back, check out the previous tag.

```bash
git tag -a stable-m9 -m "Stable Atelier"
git -C ../atelier-stable checkout --detach stable-m9 && pnpm -C ../atelier-stable install
```

## Checks and measurements

```bash
pnpm check   # lint + typecheck + test (no network, no subscription usage)
node atelier-core/scripts/measure-cache.ts       # measures the prompt cache on the real API (costs a few cents)
node atelier-core/scripts/measure-subagents.ts   # same question with and without a subagent, on the real API
node atelier-core/scripts/measure-review.ts --backend anthropic-api   # reviews seeded changes in scratch repos (costs real money or subscription usage); also --backend claude-code
node atelier-core/scripts/measure-compaction.ts --backend anthropic-api   # forces compactions with a low threshold and checks what the agent remembers (costs real money); also --backend claude-code
```

`ATELIER_RECORD_SDK=<file.jsonl>` appends every raw SDK message during a real run; that is how `atelier-core/test/fixtures/claude-code/` is recorded.

## Versioning

Atelier has one version, [semantic](https://semver.org) and still `0.x`: the root `package.json`, every package's `package.json` and `VERSION` in `atelier-core/src/version.ts` carry the same one, and a test fails when they differ. `atelier --version` prints it, and the core sends it in the protocol's `hello`.

To release, on `main` with `pnpm check` green: bump the version in those five places in one commit (`chore: release v0.2.0`), then tag that commit and push both:

```bash
git tag -a v0.2.0 -m "Atelier v0.2.0"
git push origin main v0.2.0
```

While the version is `0.x`, a minor bump (`0.2.0`) may change behavior and a patch (`0.1.1`) only fixes.
