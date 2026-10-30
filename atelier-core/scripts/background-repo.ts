/**
 * The throwaway repository of measure-delegation's --background: a git repository with a commit, as a background
 * worker needs, holding the copy of src, a test folder and the checks a task names, run with what atelier-core
 * already has installed.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The checks of the repository, as a task tells the agent to run them. */
export const CHECKS = "node_modules/.bin/tsc -p . && node_modules/.bin/vitest run";

/**
 * Makes `cwd`, which holds `src`, a repository with `test/`, a tsconfig from `base`, a vitest config and a
 * `node_modules` of links to the entries of each of `modules` (the first one that has an entry wins), committed but
 * for `node_modules`.
 */
export async function makeBackgroundRepo(cwd: string, base: string, modules: readonly string[]): Promise<void> {
	const { compilerOptions } = JSON.parse(await readFile(base, "utf8")) as { compilerOptions: { lib?: string[] } };
	// The whole project brings DOM's stream types along; src alone needs them named.
	compilerOptions.lib = [...(compilerOptions.lib ?? []), "DOM"];
	await writeFile(
		join(cwd, "package.json"),
		`${JSON.stringify({ name: "measured", private: true, type: "module" })}\n`,
	);
	await writeFile(join(cwd, "tsconfig.json"), `${JSON.stringify({ compilerOptions, include: ["src", "test"] })}\n`);
	await writeFile(join(cwd, "vitest.config.ts"), 'export default { test: { include: ["test/**/*.test.ts"] } };\n');
	await writeFile(join(cwd, ".gitignore"), "node_modules/\n");
	await mkdir(join(cwd, "test"));
	await writeFile(
		join(cwd, "test", "text.test.ts"),
		[
			'import { expect, it } from "vitest";',
			'import { visibleText } from "../src/text.ts";',
			"",
			'it("leaves a text without hidden characters as it is", () => {',
			'\texpect(visibleText("abc")).toEqual({ text: "abc", hadHidden: false });',
			"});",
			"",
		].join("\n"),
	);
	await linkModules(join(cwd, "node_modules"), modules);
	const git = (...args: string[]) =>
		run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], { cwd });
	await git("init", "-q");
	await git("add", "-A");
	await git("-c", "user.name=measure", "-c", "user.email=measure@example.invalid", "commit", "-q", "-m", "start");
}

/** A folder of links to the entries of `modules`; a scope or `.bin` is a folder of links too, merged. */
async function linkModules(target: string, modules: readonly string[]): Promise<void> {
	await mkdir(target);
	const taken = new Set<string>();
	for (const folder of modules) {
		for (const entry of await readdir(folder)) {
			if (entry.startsWith(".") && entry !== ".bin") continue;
			if (entry.startsWith("@") || entry === ".bin") {
				await mkdir(join(target, entry), { recursive: true });
				for (const inner of await readdir(join(folder, entry))) {
					const name = `${entry}/${inner}`;
					if (taken.has(name)) continue;
					taken.add(name);
					await symlink(join(folder, entry, inner), join(target, entry, inner));
				}
				continue;
			}
			if (taken.has(entry)) continue;
			taken.add(entry);
			await symlink(join(folder, entry), join(target, entry));
		}
	}
}

/** Whether the repository's checks pass now. */
export async function checksPass(cwd: string): Promise<boolean> {
	try {
		await run("sh", ["-c", CHECKS], { cwd, timeout: 300_000 });
		return true;
	} catch {
		return false;
	}
}
