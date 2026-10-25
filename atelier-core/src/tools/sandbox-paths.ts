import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

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

/** The `core.hooksPath` and the include paths a git configuration file names, read without git so a broken file still answers. */
export function configFilePaths(file: string): { hooksPath?: string; includes: string[] } {
	const found: { hooksPath?: string; includes: string[] } = { includes: [] };
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return found;
	}
	let section = "";
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\](.*)$/.exec(line);
		if (header) {
			section = (header[1] ?? "").toLowerCase();
			continue;
		}
		const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*?)\s*(?:[#;].*)?$/.exec(line);
		if (!entry) continue;
		const key = (entry[1] ?? "").toLowerCase();
		const value = (entry[2] ?? "").replace(/^"(.*)"$/, "$1");
		if (key === "path" && (section === "include" || section === "includeif")) found.includes.push(value);
		else if (key === "hookspath" && section === "core") found.hooksPath = value;
	}
	return found;
}

/** A path from a git configuration file, as git resolves it: `~/` is the home, a relative one is relative to `base`. */
export function configPath(value: string, base: string, home: string): string {
	if (value.startsWith("~/")) return join(home, value.slice(2));
	return isAbsolute(value) ? value : resolve(base, value);
}

const MAX_INCLUDE_DEPTH = 10;

/**
 * The files the given git configuration files include (`include.path`,
 * `includeIf.<condition>.path`), whatever the condition, through the included
 * files that can be read, down to a fixed depth. They run code the same way the
 * configuration does (`core.hooksPath`, `core.fsmonitor`), so they are listed
 * whether they exist or not.
 */
export function includedConfigFiles(files: string[], home: string): string[] {
	const found = new Set<string>();
	const visit = (file: string, depth: number) => {
		if (depth > MAX_INCLUDE_DEPTH) return;
		for (const include of configFilePaths(file).includes) {
			const path = configPath(include, dirname(file), home);
			if (found.has(path)) continue;
			found.add(path);
			visit(path, depth + 1);
		}
	};
	for (const file of files) visit(file, 0);
	return [...found];
}
