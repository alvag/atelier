import { join } from "node:path";

/** Files that hold secrets in a project: no command may write them, wherever they sit under `dir`. */
export function secretFilePatterns(dir: string): string[] {
	return [".env", ".env.*", "**/.env", "**/.env.*", "**/*.pem", "**/*.key"].map((pattern) => join(dir, pattern));
}

/**
 * What the library protects by itself (git hooks and configuration, shell
 * start-up files, editor and tool configuration), but only in the directory the
 * process was started in, which is not the session's working directory when
 * `--cwd` or a desktop client sets another. So the policy repeats it for the
 * working directory and every directory the configuration adds.
 */
export function libraryProtectedPaths(dir: string): string[] {
	return [
		".git/hooks",
		".git/config",
		".gitconfig",
		".gitmodules",
		".bashrc",
		".bash_profile",
		".zshrc",
		".zprofile",
		".profile",
		".ripgreprc",
		".mcp.json",
		".vscode",
		".idea",
		".claude/commands",
		".claude/agents",
	].map((path) => join(dir, path));
}

/** What the user keeps private: no command of the main agent may read it. */
export function secretDirectories(home: string): string[] {
	return [".ssh", ".aws", ".gnupg", ".config/gh", "Library/Keychains", ".claude"].map((path) => join(home, path));
}

/**
 * The per-user caches and stores of the package managers and build tools, which
 * the agent's commands write so that installing and building keep working:
 * npm, pnpm (its store and cache, on macOS and by XDG), yarn, `~/.cache` and
 * `~/Library/Caches` (which hold the corepack, node-gyp, pip and Yarn caches
 * too) and node-gyp's own `~/.node-gyp`. Never home itself, never a secret.
 */
export function packageCacheDirectories(home: string): string[] {
	return [
		".npm",
		"Library/pnpm",
		".local/share/pnpm",
		".pnpm-store",
		".yarn",
		".node-gyp",
		".cache",
		"Library/Caches",
	].map((path) => join(home, path));
}
