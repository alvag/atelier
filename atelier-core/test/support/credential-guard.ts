import childProcess from "node:child_process";
import { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

/** The user's own home, from the account database: what HOME is when nothing isolates it. */
export const REAL_HOME = userInfo().homedir;

/**
 * What no test may run: the Claude Code of the Agent SDK or a `claude` on the PATH (the real login), and macOS
 * `security` (the real Keychain). Tests pass a fake binary and a fake Keychain instead.
 */
export function forbiddenCommand(command: string): boolean {
	const name = basename(command);
	if (name === "security") return true;
	if (name === "claude" || name === "claude.exe")
		return command === name || /claude-agent-sdk-[^/\\]+[/\\]claude(\.exe)?$/.test(command);
	return false;
}

/**
 * Makes every way of starting a process refuse a forbidden command, in this process and in the modules that import
 * `node:child_process` by name (the builtin's named exports follow `syncBuiltinESMExports`). `onViolation` hears it
 * first: a test that swallows the error still fails.
 */
export function guardCredentials(onViolation: (command: string) => void): void {
	const check = (command: unknown) => {
		if (typeof command !== "string" || !forbiddenCommand(command)) return;
		onViolation(command);
		throw new Error(`test isolation: ${command} must not run in tests; inject a fake`);
	};
	type Starter = ((...args: unknown[]) => unknown) & { [promisify.custom]?: (...args: unknown[]) => unknown };
	const patched = childProcess as unknown as Record<string, Starter>;
	for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) {
		const original = patched[name];
		if (original === undefined) continue;
		const guarded: Starter = (command: unknown, ...rest: unknown[]) => {
			check(command);
			return original.call(childProcess, command, ...rest);
		};
		// `promisify(execFile)` resolves with stdout and stderr through its own version: keep it, checked too.
		const custom = original[promisify.custom];
		if (custom !== undefined)
			guarded[promisify.custom] = (command: unknown, ...rest: unknown[]) => {
				check(command);
				return custom.call(childProcess, command, ...rest);
			};
		patched[name] = guarded;
	}
	syncBuiltinESMExports();
}

/** A fresh, empty home, so nothing a test does reaches the real `~/.atelier`, `~/.claude` or the Keychain's owner. */
export function isolatedHome(): string {
	return mkdtempSync(join(tmpdir(), "atelier-test-home-"));
}
