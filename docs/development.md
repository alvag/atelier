# Development

Packages, checks, measurement scripts, and how to work on Atelier with Atelier.

## Packages

| Package            | Directory          | Status                                                                                                           |
| ------------------ | ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `@atelier/core`    | `atelier-core/`    | Event contract, session, tools, subagents, protocol server; backends `claude-code` (M1) and `anthropic-api` (M3) |
| `@atelier/cli`     | `atelier-cli/`     | `atelier` command                                                                                                |
| `@atelier/desktop` | `atelier-desktop/` | Desktop chat app (M2)                                                                                            |

## Working on Atelier with Atelier

Changing Atelier with the Atelier you are changing breaks the tool in the middle of the work. The installed copy is the tool and a clone of the repository is the workpiece:

```
~/.atelier/app/   the tool: installed with install.sh, pinned to a vX.Y.Z release, never edited
atelier/          the workpiece: your clone, feat/* branches, where the agent edits
```

```bash
cd atelier && pnpm install
atelier                 # the installed release works on the clone
pnpm atelier            # the clone's own CLI, in another terminal, to try a change for real
pnpm desktop            # the clone's desktop, with hot reload
```

- The agent never writes `~/.atelier/`: `edit`, `write` and the `bash` sandbox refuse it, so the tool cannot change itself.
- Memory (Engram resolves the project from the working directory), review receipts (in the workpiece's `.git`) and the API key are shared on purpose.
- `atelier update` refuses a clone (it only moves a copy installed with `install.sh`); in the clone, use git.

Release only what is verified: once a branch is merged into `main` with `pnpm check`, the desktop smoke and a real run green, release it (see "Versioning" below) and run `atelier update`. To go back, `atelier update <previous version>`.

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

To release, on `main` with `pnpm check` green:
1. Bump the version in those five places and add a section for it at the top of `CHANGELOG.md` saying what the release brings, in one commit (`chore: release v0.2.0`).
2. Tag that commit with the same notes, push both, and publish the GitHub release with them:

```bash
git tag -a v0.2.0 -m "Atelier v0.2.0"
git push origin main v0.2.0
gh release create v0.2.0 --title "Atelier v0.2.0" --notes "<the v0.2.0 section of CHANGELOG.md>"
```

`install.sh` and `atelier update` pick the newest `vX.Y.Z` tag, so a release reaches every installed copy on its next `atelier update`.

While the version is `0.x`, a minor bump (`0.2.0`) may change behavior and a patch (`0.1.1`) only fixes.
