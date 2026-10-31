import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runUserShell, type UserShellResult } from "../src/tui/user-shell.ts";

const cleanup: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

const scratch = () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "atelier-user-shell-test-")));
	cleanup.push(dir);
	return dir;
};

/** Waits for what the test needs, never a fixed delay. */
const until = async (condition: () => boolean) => {
	for (let i = 0; i < 1000 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
};

const run = (command: string, options: Partial<Parameters<typeof runUserShell>[1]> = {}) => {
	const live: string[] = [];
	const result = runUserShell(command, { cwd: scratch(), onOutput: (text) => live.push(text), ...options });
	return { live, result };
};

/** Runs to the end and schedules the private directory of a saved output for removal. */
const finish = async (command: string, options: Partial<Parameters<typeof runUserShell>[1]> = {}) => {
	const done: UserShellResult = await run(command, options).result;
	if (done.fullOutputPath) cleanup.push(dirname(done.fullOutputPath));
	return done;
};

describe("runUserShell", () => {
	it("runs in the given cwd with the inherited environment and streams stdout and stderr", async () => {
		const cwd = scratch();
		const env = { ...process.env, ATELIER_SHELL_TEST: "seen" };
		const { live, result } = run('pwd; echo "$ATELIER_SHELL_TEST"; echo oops >&2', { cwd, env });
		const done = await result;
		expect(done).toMatchObject({ exitCode: 0, cancelled: false, truncated: false });
		expect(done.output).toContain(cwd);
		expect(done.output).toContain("seen");
		expect(done.output).toContain("oops");
		expect(live.join("")).toBe(done.output);
	});

	it("uses SHELL with -c and falls back to /bin/sh", async () => {
		const withShell = await finish('echo "$0"', { env: { SHELL: "/bin/bash" } });
		expect(withShell.output.trim()).toMatch(/bash$/);
		const { SHELL: _, ...rest } = process.env;
		const fallback = await finish("echo ok", { env: rest });
		expect(fallback.output).toBe("ok\n");
	});

	it("reports empty output, and a non-zero exit code", async () => {
		expect(await finish("true")).toMatchObject({ output: "", exitCode: 0, cancelled: false, truncated: false });
		expect(await finish("echo bad; exit 3")).toMatchObject({ output: "bad\n", exitCode: 3 });
	});

	it("reports a cwd that cannot be used as an error", async () => {
		const doneCwd = scratch();
		const done = await finish("true", { cwd: join(doneCwd, "missing") });
		expect(done.exitCode).toBeNull();
		expect(done.error).toBe(`Working directory does not exist: ${join(doneCwd, "missing")}`);
	});

	it("returns an error result when cwd is a file instead of rejecting", async () => {
		const cwd = join(scratch(), "file");
		writeFileSync(cwd, "not a directory");
		const done = await finish("true", { cwd });
		expect(done.exitCode).toBeNull();
		expect(done.error).toBe(`Working directory is not a directory: ${cwd}`);
	});

	it("identifies an inaccessible cwd without blaming the shell", async () => {
		const cwd = scratch();
		chmodSync(cwd, 0);
		try {
			const done = await finish("true", { cwd });
			expect(done.exitCode).toBeNull();
			expect(done.error).toContain(`Working directory is not accessible: ${cwd}`);
			expect(done.error).not.toContain("spawn /bin/");
		} finally {
			chmodSync(cwd, 0o700);
		}
	});

	it("returns synchronous spawn failures as error results", async () => {
		const done = await finish("true", { env: { ...process.env, SHELL: "/invalid\0shell" } });
		expect(done.exitCode).toBeNull();
		expect(done.error).toMatch(/null bytes/);
	});

	it("still identifies a missing shell when cwd exists", async () => {
		const missing = join(scratch(), "missing-shell");
		const done = await finish("true", { env: { ...process.env, SHELL: missing } });
		expect(done.error).toContain(missing);
		expect(done.error).not.toContain("Working directory");
	});

	it("gives the command no stdin and no controlling terminal", async () => {
		const done = await finish("cat; echo eof:$?; (: </dev/tty) 2>/dev/null; echo tty:$?");
		expect(done.exitCode).toBe(0);
		expect(done.output).toMatch(/^eof:0\ntty:[1-9]/);
	});

	it("keeps the tail of a large output and the whole of it in a private file", async () => {
		const done = await finish(`node -e 'process.stdout.write("é".repeat(100000) + "\\nlast\\n")'`);
		expect(done).toMatchObject({ exitCode: 0, truncated: true });
		expect(Buffer.byteLength(done.output)).toBeLessThanOrEqual(50 * 1024);
		expect(done.output.endsWith("last\n")).toBe(true);
		expect(done.output).not.toContain("�");
		const path = done.fullOutputPath as string;
		expect(realpathSync(path).startsWith(realpathSync(tmpdir()))).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(`${"é".repeat(100000)}\nlast\n`);
	});

	it.each([60000, 3 * 1024 * 1024])(
		"keeps original undecodable bytes in the %s-byte full-output file",
		async (size) => {
			const done = await finish(
				`node -e 'process.stdout.write(Buffer.concat([Buffer.from([255,254,195]),Buffer.alloc(${size},255)]))'`,
			);
			expect(done.truncated).toBe(true);
			expect(Buffer.byteLength(done.output)).toBeLessThanOrEqual(50 * 1024);
			expect(
				readFileSync(done.fullOutputPath as string).equals(
					Buffer.concat([Buffer.from([255, 254, 195]), Buffer.alloc(size, 255)]),
				),
			).toBe(true);
		},
	);

	it.each([false, true])("keeps exactly 2000 lines without truncation (final newline=%s)", async (newline) => {
		const output = Array.from({ length: 2000 }, (_, i) => i + 1).join("\n") + (newline ? "\n" : "");
		const command = `node -e 'process.stdout.write(Array.from({length:2000},(_,i)=>i+1).join("\\n")${newline ? '+"\\n"' : ""})'`;
		const done = await finish(command);
		expect(done).toMatchObject({ output, truncated: false });
		expect(done.fullOutputPath).toBeUndefined();
	});

	it.each([50 * 1024 - 1, 50 * 1024, 50 * 1024 + 1])(
		"only truncates when %s bytes exceed the byte limit",
		async (bytes) => {
			const done = await finish(`node -e 'process.stdout.write("x".repeat(${bytes}))'`);
			expect(done.output).toBe("x".repeat(Math.min(bytes, 50 * 1024)));
			expect(done.truncated).toBe(bytes > 50 * 1024);
			if (bytes <= 50 * 1024) expect(done.fullOutputPath).toBeUndefined();
			else expect(readFileSync(done.fullOutputPath as string)).toEqual(Buffer.alloc(bytes, 120));
		},
	);

	it("keeps the last 2000 of 2001 lines and captures all original bytes", async () => {
		const done = await finish("seq 1 2001");
		expect(done.truncated).toBe(true);
		expect(done.output).toBe(`${Array.from({ length: 2000 }, (_, i) => i + 2).join("\n")}\n`);
		expect(readFileSync(done.fullOutputPath as string, "utf8")).toBe(
			`${Array.from({ length: 2001 }, (_, i) => i + 1).join("\n")}\n`,
		);
	});

	it("truncates by lines and saves the full output only then", async () => {
		const many = await finish("seq 1 3000");
		expect(many.truncated).toBe(true);
		expect(many.output.startsWith("1002\n") || Number(many.output.split("\n")[0]) > 1000).toBe(true);
		const all = Array.from({ length: 3000 }, (_, i) => i + 1).join("\n");
		expect(readFileSync(many.fullOutputPath as string, "utf8")).toBe(`${all}\n`);
		const small = await finish("seq 1 5");
		expect(small).toMatchObject({ truncated: false, output: "1\n2\n3\n4\n5\n" });
		expect(small.fullOutputPath).toBeUndefined();
	});

	it("does not spawn when cancellation preceded execution", async () => {
		const controller = new AbortController();
		controller.abort();
		const done = await finish("true", { cwd: "/missing-shell-cwd", signal: controller.signal });
		expect(done).toEqual({ output: "", exitCode: null, cancelled: true, truncated: false });
	});

	it("reports missing full-output storage without hiding truncation or inventing a path", async () => {
		vi.stubEnv("TMPDIR", join(scratch(), "missing"));
		const done = await runUserShell("seq 1 30000", { cwd: process.cwd() });
		expect(done.truncated).toBe(true);
		expect(done.error).toBeTruthy();
		expect(done.fullOutputPath).toBeUndefined();
	});

	it("decodes UTF-8 independently for stdout and stderr while streaming", async () => {
		const dir = scratch();
		const first = join(dir, "first");
		const second = join(dir, "second");
		const script = `const fs=require("node:fs"); const wait=(p,f)=>fs.existsSync(p)?f():setImmediate(()=>wait(p,f)); process.stdout.write(Buffer.from([112,114,101,102,105,120,0xe2])); wait(${JSON.stringify(first)},()=>{process.stderr.write("middle\\n");wait(${JSON.stringify(second)},()=>process.stdout.write(Buffer.from([0x82,0xac])));});`;
		const live: string[] = [];
		const done = await runUserShell(`node -e '${script}'`, {
			cwd: dir,
			onOutput: (text) => {
				live.push(text);
				if (text.includes("prefix")) writeFileSync(first, "");
				if (text.includes("middle")) writeFileSync(second, "");
			},
		});
		expect(live.join("")).toBe("prefixmiddle\n€");
		expect(done.output).toBe(live.join(""));
	});

	it("cancels the whole process group and waits for it", async () => {
		const dir = scratch();
		const pidFile = join(dir, "child.pid");
		const controller = new AbortController();
		const { result, live } = run(`echo $$; sleep 300 & echo $! > ${pidFile}; echo ready; wait`, {
			cwd: dir,
			signal: controller.signal,
		});
		const groupAlive = () => {
			try {
				process.kill(-leader, 0);
				return true;
			} catch (error) {
				expect(error).toMatchObject({ code: "ESRCH" });
				return false;
			}
		};
		let leader = 0;
		try {
			await until(() => live.join("").includes("ready") && existsSync(pidFile));
			// The shell is the group leader, so its own pid names the group the runner must signal.
			leader = Number(live.join("").split("\n")[0]);
			expect(leader).toBeGreaterThan(1);
			expect(groupAlive()).toBe(true);
			controller.abort();
			const done = await result;
			expect(done.cancelled).toBe(true);
			expect(done.signal).toBe("SIGTERM");
			await until(() => !groupAlive());
		} finally {
			controller.abort();
			// Only the group this test started is addressed; it is normally gone already.
			if (leader > 1 && groupAlive()) process.kill(-leader, "SIGKILL");
			await result;
		}
	});

	it.each([false, true])(
		"bounds cancellation with setsid-held pipes (shell ignores TERM=%s)",
		async (ignoreTerm) => {
			const pidFile = join(scratch(), "escaped.pid");
			const controller = new AbortController();
			const script = `import os,time; os.fork() and os._exit(0); os.setsid(); open(${JSON.stringify(pidFile)},"w").write(str(os.getpid())); print("escaped",flush=True); time.sleep(60)`;
			const tail = ignoreTerm ? "trap '' TERM; echo started; while :; do sleep 1; done" : "echo started";
			const { result, live } = run(`python3 -c '${script}'; ${tail}`, { signal: controller.signal });
			let deadline: NodeJS.Timeout | undefined;
			try {
				await until(
					() => existsSync(pidFile) && live.join("").includes("escaped") && live.join("").includes("started"),
				);
				controller.abort();
				const done = await Promise.race([
					result,
					new Promise<never>((_, reject) => {
						deadline = setTimeout(() => reject(new Error("cancellation is still waiting on inherited pipes")), 3500);
					}),
				]);
				expect(done.cancelled).toBe(true);
				expect(done.output).toContain("started");
				// Cancellation must finish without waiting for the escaped process to close its descriptors.
				expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).not.toThrow();
			} finally {
				clearTimeout(deadline);
				controller.abort();
				if (existsSync(pidFile)) {
					try {
						process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
					} catch {
						// This test owns the escaped process; it may already be gone.
					}
				}
				await result;
			}
		},
		10_000,
	);

	it.each(["stdout", "stderr"] as const)(
		"resolves shortly after the shell exits while a live descendant retains %s",
		async (stream) => {
			const dir = scratch();
			const pidFile = join(dir, "descendant.pid");
			const gate = join(dir, "gate");
			const wrote = join(dir, "wrote");
			const fd = stream === "stdout" ? 1 : 2;
			// The descendant holds the inherited pipe until the test opens the gate, then tries to write late output.
			const script = `const fs=require("node:fs"); fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid)); setTimeout(()=>process.exit(0),30000); const t=setInterval(()=>{ if(!fs.existsSync(${JSON.stringify(gate)})) return; clearInterval(t); let outcome="written"; try{fs.writeSync(${fd},"late")}catch(error){outcome=error.code} fs.writeFileSync(${JSON.stringify(wrote)},outcome); process.exit(0)},5)`;
			const redirect = stream === "stdout" ? "" : " >&2";
			const background = stream === "stdout" ? "2>/dev/null" : ">/dev/null";
			const command = `node -e '${script}' ${background} & while [ ! -e ${pidFile} ]; do sleep 0.02; done; echo before${redirect}; exit 0`;
			const controller = new AbortController();
			const { result, live } = run(command, {
				cwd: dir,
				signal: controller.signal,
				env: { ...process.env, SHELL: "/bin/sh" },
			});
			let deadline: NodeJS.Timeout | undefined;
			try {
				const done = await Promise.race([
					result,
					new Promise<never>((_, reject) => {
						deadline = setTimeout(() => reject(new Error("still waiting on pipes held after the shell exited")), 3000);
					}),
				]);
				expect(done).toMatchObject({ exitCode: 0, cancelled: false, output: "before\n" });
				// Finishing the command does not kill the descendant.
				expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).not.toThrow();
				writeFileSync(gate, "");
				await until(() => existsSync(wrote));
				expect(readFileSync(wrote, "utf8")).toBe("EPIPE");
				expect(live.join("")).toBe("before\n");
			} finally {
				clearTimeout(deadline);
				controller.abort();
				writeFileSync(gate, "");
				if (existsSync(pidFile)) {
					try {
						process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
					} catch {
						// This test owns the descendant; it may already be gone.
					}
				}
				try {
					await Promise.race([
						result,
						new Promise((resolve) => {
							deadline = setTimeout(resolve, 3000);
						}),
					]);
				} finally {
					clearTimeout(deadline);
				}
			}
		},
		10_000,
	);

	it("keeps cancellation's SIGKILL grace when abort arrives during the post-exit drain", async () => {
		const dir = scratch();
		const shellFile = join(dir, "shell.pid");
		const childFile = join(dir, "child.pid");
		const ready = join(dir, "ready");
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const controller = new AbortController();
		const command = `echo $$ > ${shellFile}; (trap '' TERM; touch ${ready}; while :; do sleep 1; done) & echo $! > ${childFile}; while [ ! -e ${ready} ]; do sleep 0.01; done; exit 0`;
		const { result } = run(command, { cwd: dir, signal: controller.signal, env: { ...process.env, SHELL: "/bin/sh" } });
		try {
			await until(
				() => existsSync(shellFile) && existsSync(childFile) && !alive(Number(readFileSync(shellFile, "utf8"))),
			);
			controller.abort();
			const done = await result;
			expect(done.cancelled).toBe(true);
			await until(() => !alive(Number(readFileSync(childFile, "utf8"))));
		} finally {
			controller.abort();
			if (existsSync(shellFile) && existsSync(childFile) && alive(Number(readFileSync(childFile, "utf8")))) {
				try {
					process.kill(-Number(readFileSync(shellFile, "utf8")), "SIGKILL");
				} catch {
					// Only this test's process group is addressed; it may already have exited.
				}
			}
			await result;
		}
	}, 10_000);

	it("kills with SIGKILL a descendant that ignores SIGTERM after the shell exited", async () => {
		const pidFile = join(scratch(), "child.pid");
		const controller = new AbortController();
		const command = `(trap '' TERM; sleep 300) & echo $! > ${pidFile}; trap 'exit 0' TERM; echo ready; while :; do sleep 1; done`;
		const { result, live } = run(command, { signal: controller.signal });
		await until(() => live.join("").includes("ready") && existsSync(pidFile));
		const childPid = Number(readFileSync(pidFile, "utf8"));
		controller.abort();
		const done = await result;
		expect(done.cancelled).toBe(true);
		// SIGKILL and reaping are asynchronous; observe the child's exit rather than assume it is instantaneous.
		await until(() => {
			try {
				process.kill(childPid, 0);
				return false;
			} catch {
				return true;
			}
		});
	});
});
