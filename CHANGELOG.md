# Changelog

Each release of Atelier, newest first. A release is the `vX.Y.Z` tag on `main`; its GitHub release carries the same notes.

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
