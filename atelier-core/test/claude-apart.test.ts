import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { HERDR_PANE_VARIABLE, inHerdrPane, spawnApart } from "../src/claude-apart.ts";
import { isInsideSandbox } from "../src/tools/sandbox.ts";

const until = async (condition: () => boolean, rounds = 600) => {
	for (let i = 0; i < rounds && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(condition()).toBe(true);
};

/** Whether a process runs, a zombie not counted: one killed is a zombie until its parent, or launchd, reaps it. */
function running(pid: number): boolean {
	const stat = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
	return stat !== "" && !stat.startsWith("Z");
}

/** The process group of `pid`, as `ps` says it. */
const groupOf = (pid: number) =>
	Number(spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim());

/** The pids of the processes in group `pgid` that still run. */
function inGroup(pgid: number): number[] {
	const rows = spawnSync("/bin/ps", ["-A", "-o", "pid=,pgid=,stat="], { encoding: "utf8" }).stdout.trim().split("\n");
	return rows
		.map((row) => row.trim().split(/\s+/))
		.filter(([, group, stat]) => Number(group) === pgid && !stat?.startsWith("Z"))
		.map(([pid]) => Number(pid));
}

/** Process groups are read with `ps`, which a sandbox around the tests refuses. */
const canListProcesses = process.platform !== "darwin" || !isInsideSandbox();

const apartModule = fileURLToPath(new URL("../src/claude-apart.ts", import.meta.url));

let dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "atelier-claude-apart-"));
	dirs.push(dir);
	return dir;
}

/**
 * A stand-in for Claude Code that writes its pid and loops until signaled. `polite` answers TERM by writing `term`,
 * taking a moment to finish (its transcript, say) and writing `done`; otherwise it ignores TERM.
 */
function fakeClaude(dir: string, polite: boolean): string {
	const path = join(dir, "claude");
	const onTerm = polite
		? `trap 'echo term >> "${dir}/claude.log"; sleep 0.3; echo done >> "${dir}/claude.log"; exit 0' TERM`
		: "trap '' TERM";
	writeFileSync(path, `#!/bin/sh\n${onTerm}\necho $$ > "${dir}/claude.pid"\nwhile :; do sleep 0.1; done\n`);
	chmodSync(path, 0o755);
	return path;
}

/** A stand-in for the core: it runs the fake Claude Code apart, and exits by itself when its input says so. */
function fakeCore(dir: string, claude: string) {
	const script = join(dir, "core.mjs");
	writeFileSync(
		script,
		[
			`const { spawnApart } = await import(${JSON.stringify(apartModule)});`,
			`spawnApart(${JSON.stringify(claude)}, [], { stdio: ["ignore", "ignore", "ignore"], env: process.env });`,
			`process.stdin.on("data", () => process.exit(0));`,
		].join("\n"),
	);
	return spawn(process.execPath, [script], { stdio: ["pipe", "ignore", "inherit"] });
}

const claudePid = (dir: string) => Number(readFileSync(join(dir, "claude.pid"), "utf8").trim());
const claudeLog = (dir: string) => {
	const path = join(dir, "claude.log");
	return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
};

describe("spawnApart", () => {
	it.skipIf(!canListProcesses)("runs the command as the leader of a process group of its own", async () => {
		const dir = tempDir();
		const child = spawnApart(fakeClaude(dir, true), [], { stdio: ["ignore", "ignore", "ignore"], env: process.env });
		await until(() => existsSync(join(dir, "claude.pid")));
		const pid = claudePid(dir);
		expect(pid).toBe(child.pid);
		expect(groupOf(pid)).toBe(pid);
		expect(groupOf(pid)).not.toBe(groupOf(process.pid));
		child.kill("SIGTERM");
		await until(() => inGroup(pid).length === 0);
	});

	for (const end of ["exits", "SIGTERM", "SIGKILL"] as const)
		it.skipIf(!canListProcesses)(`ends the command's group, TERM first, when the core ${end}`, async () => {
			const dir = tempDir();
			const core = fakeCore(dir, fakeClaude(dir, true));
			await until(() => existsSync(join(dir, "claude.pid")));
			const pid = claudePid(dir);
			if (end === "exits") core.stdin.write("bye\n");
			else core.kill(end);
			await until(() => !running(pid));
			await until(() => inGroup(pid).length === 0);
			// Claude Code got TERM and the time to finish what it was writing.
			expect(claudeLog(dir)).toEqual(["term", "done"]);
		});

	it.skipIf(!canListProcesses)("gives the whole group the grace, though the command itself ends at TERM", async () => {
		const dir = tempDir();
		const claude = join(dir, "claude");
		// The command leaves at TERM; a child of its group takes half a second to finish what it writes.
		writeFileSync(
			claude,
			[
				"#!/bin/sh",
				`( trap 'echo term >> "${dir}/claude.log"; sleep 0.5; echo done >> "${dir}/claude.log"; exit 0' TERM; echo $(sh -c 'echo $PPID') > "${dir}/worker.pid"; while :; do sleep 0.1; done ) &`,
				`echo $$ > "${dir}/claude.pid"`,
				"while :; do sleep 0.1; done",
			].join("\n"),
		);
		chmodSync(claude, 0o755);
		const core = fakeCore(dir, claude);
		await until(() => existsSync(join(dir, "claude.pid")) && existsSync(join(dir, "worker.pid")));
		const pid = claudePid(dir);
		core.kill("SIGKILL");
		await until(() => inGroup(pid).length === 0);
		expect(claudeLog(dir)).toEqual(["term", "done"]);
	});

	it.skipIf(!canListProcesses)("kills a command that ignores TERM after a short grace", async () => {
		const dir = tempDir();
		const core = fakeCore(dir, fakeClaude(dir, false));
		await until(() => existsSync(join(dir, "claude.pid")));
		const pid = claudePid(dir);
		const killedAt = Date.now();
		core.kill("SIGKILL");
		await until(() => !running(pid));
		await until(() => inGroup(pid).length === 0);
		expect(Date.now() - killedAt).toBeGreaterThanOrEqual(1500);
	});

	it.skipIf(!canListProcesses)("ends the rest of the group once the command exits by itself", async () => {
		const dir = tempDir();
		const script = join(dir, "claude");
		// The command leaves a child behind in its group when it exits.
		writeFileSync(script, `#!/bin/sh\nsleep 30 &\necho $! > "${dir}/left.pid"\n`);
		chmodSync(script, 0o755);
		const child = spawnApart(script, [], { stdio: ["ignore", "ignore", "ignore"], env: process.env });
		const pgid = child.pid as number;
		await new Promise((resolve) => child.once("exit", resolve));
		await until(() => existsSync(join(dir, "left.pid")));
		await until(() => inGroup(pgid).length === 0);
	});
});

describe("inHerdrPane", () => {
	it("says whether the TUI that started the core reports a Herdr pane", () => {
		expect(HERDR_PANE_VARIABLE).toBe("ATELIER_HERDR_PANE");
		expect(inHerdrPane({ ATELIER_HERDR_PANE: "w1:p1" }, "darwin")).toBe(true);
		expect(inHerdrPane({ ATELIER_HERDR_PANE: "w1:p1" }, "linux")).toBe(true);
		expect(inHerdrPane({}, "darwin")).toBe(false);
		expect(inHerdrPane({ ATELIER_HERDR_PANE: "" }, "darwin")).toBe(false);
		// Windows has no process groups to set apart: Claude Code runs there as it always did.
		expect(inHerdrPane({ ATELIER_HERDR_PANE: "w1:p1" }, "win32")).toBe(false);
	});
});
