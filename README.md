# Atelier

Coding-agent orchestrator with two first-class clients: a CLI and a desktop app, both on top of a headless core.

| Package            | Directory          | Status |
| ------------------ | ------------------ | ------ |
| `@atelier/core`    | `atelier-core/`    | M1     |
| `@atelier/cli`     | `atelier-cli/`     | M1     |
| `@atelier/desktop` | `atelier-desktop/` | M2     |

## Development

Requires Node 22.18+ (TypeScript runs natively, no build step) and pnpm.

```bash
pnpm install
pnpm check   # lint + typecheck + test
```
