#!/bin/sh
# Installs Atelier from GitHub:
#   curl -fsSL https://raw.githubusercontent.com/alvag/atelier/main/install.sh | sh
#
# Clones the repository, checks out the newest vX.Y.Z tag, installs the CLI
# dependencies and puts an `atelier` launcher on the user's bin dir.
#
# Environment overrides (for tests and power users):
#   ATELIER_REPO         clone source (default: https://github.com/alvag/atelier.git)
#   ATELIER_INSTALL_DIR  where to clone (default: $HOME/.atelier/app)
#   ATELIER_BIN_DIR      where the launcher goes (default: $HOME/.local/bin)
#
# The file `.git/atelier-install` in the clone marks it as installed by this
# script (`atelier update` only acts on copies that have it). It lives inside
# .git so the worktree stays clean. Format: key=value lines; `desktop=1` when
# the desktop app was installed, `desktop=0` otherwise.

set -eu

REPO="${ATELIER_REPO:-https://github.com/alvag/atelier.git}"
INSTALL_DIR="${ATELIER_INSTALL_DIR:-$HOME/.atelier/app}"
BIN_DIR="${ATELIER_BIN_DIR:-$HOME/.local/bin}"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=19

WITH_DESKTOP=0
CLONED=0

fail() {
	printf 'error: %s\n' "$1" >&2
	exit 1
}

usage_error() {
	printf 'error: %s\nUsage: install.sh [--desktop]\n' "$1" >&2
	exit 2
}

# Removes the clone this run created, so a failed install leaves nothing behind.
cleanup() {
	status=$?
	if [ "$status" -ne 0 ] && [ "$CLONED" -eq 1 ]; then
		rm -rf "$INSTALL_DIR"
	fi
	exit "$status"
}

parse_args() {
	for arg in "$@"; do
		case "$arg" in
			--desktop) WITH_DESKTOP=1 ;;
			*) usage_error "Unknown option: $arg" ;;
		esac
	done
}

check_requirements() {
	command -v git >/dev/null 2>&1 || fail "Atelier needs git; it was not found."
	command -v node >/dev/null 2>&1 || fail "Atelier needs Node $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer; it was not found."
	node_version=$(node --version)
	node_numbers=${node_version#v}
	node_major=${node_numbers%%.*}
	node_rest=${node_numbers#*.}
	node_minor=${node_rest%%.*}
	if [ "$node_major" -lt "$MIN_NODE_MAJOR" ] 2>/dev/null ||
		{ [ "$node_major" -eq "$MIN_NODE_MAJOR" ] && [ "$node_minor" -lt "$MIN_NODE_MINOR" ]; } 2>/dev/null; then
		fail "Atelier needs Node $MIN_NODE_MAJOR.$MIN_NODE_MINOR or newer; found $node_version."
	fi
	command -v pnpm >/dev/null 2>&1 || fail "Atelier needs pnpm; it was not found."
}

newest_release_tag() {
	git -C "$INSTALL_DIR" tag --list 'v[0-9]*.[0-9]*.[0-9]*' --sort=-v:refname |
		grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true
}

install_dependencies() {
	# The desktop needs the dev dependencies (Electron, electron-vite) to install and build.
	if [ "$WITH_DESKTOP" -eq 1 ]; then
		(cd "$INSTALL_DIR" && pnpm install --frozen-lockfile)
		(cd "$INSTALL_DIR" && pnpm -C atelier-desktop build)
	else
		(cd "$INSTALL_DIR" && pnpm install --frozen-lockfile --prod)
	fi
}

write_marker() {
	printf 'desktop=%s\n' "$WITH_DESKTOP" >"$INSTALL_DIR/.git/atelier-install"
}

write_launcher() {
	mkdir -p "$BIN_DIR"
	printf '#!/bin/sh\nexec node "%s/atelier-cli/src/main.ts" "$@"\n' "$INSTALL_DIR" >"$BIN_DIR/atelier"
	chmod 755 "$BIN_DIR/atelier"
}

warn_if_off_path() {
	case ":$PATH:" in
		*":$BIN_DIR:"*) ;;
		*) printf 'warning: %s is not on your PATH.\nAdd %s to your PATH in your shell profile, e.g.:\n  export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" "$BIN_DIR" >&2 ;;
	esac
}

main() {
	parse_args "$@"
	check_requirements
	[ -e "$INSTALL_DIR" ] && fail "Atelier is already installed in $INSTALL_DIR. Run: atelier update"

	trap cleanup EXIT
	git clone --quiet "$REPO" "$INSTALL_DIR"
	CLONED=1

	tag=$(newest_release_tag)
	[ -n "$tag" ] || fail "No vX.Y.Z release found in the repository."
	git -C "$INSTALL_DIR" -c advice.detachedHead=false checkout --quiet --detach "$tag"

	install_dependencies
	write_marker
	write_launcher
	warn_if_off_path
	printf 'Installed atelier %s in %s. Run: atelier\n' "$tag" "$INSTALL_DIR"
}

main "$@"
