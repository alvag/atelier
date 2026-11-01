import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { requireIsolatedHome } from "../../atelier-core/test/support/login-isolation.ts";

requireIsolatedHome();

// A real PTY and the real TUI (run() with pi-tui's ProcessTerminal), started twice in the same home and directory.
// Only the core is in-process and fake: it records what the TUI submits. No backend, credential or network is used.
const PROMPT = "inert history probe";
const PROBE_BUDGET_S = 25;

const driver = String.raw`
import os, pty, sys, json, time, select, signal
node, runner, folder, budget = sys.argv[1:]
began = time.monotonic()
# One deadline for both launches: every step waits for a condition, none for a fixed time.
deadline = began+float(budget)
submitted = os.path.join(folder,'submissions.json')
ready = os.path.join(folder,'ready')
def count():
 try:
  with open(submitted) as f: return len(json.load(f))
 except (FileNotFoundError, ValueError): return 0
def launch(first):
 if os.path.exists(ready): os.unlink(ready)
 pid, master = pty.fork()
 if pid == 0:
  os.chdir(os.path.join(folder,'project'))
  os.execv(node, [node,runner])
 state = {'data': b'', 'done': False}
 def wait_for(what, check):
  while time.monotonic()<deadline:
   if select.select([master],[],[],0.02)[0]:
    try: state['data'] += os.read(master,65536)
    except OSError: pass
   if check(): return
  raise RuntimeError('PTY condition timed out after %.1f s: %s' % (time.monotonic()-began, what))
 try:
  # The fake core is only connected by the TUI, and bracketed paste is on once the terminal is started.
  wait_for('the TUI', lambda: os.path.exists(ready) and b'\x1b[?2004h' in state['data'])
  if first:
   os.write(master, ${JSON.stringify(PROMPT)}.encode()+b'\r')
  else:
   os.write(master, b'\x1b[A'); os.write(master, b'\r')
  want = 1 if first else 2
  wait_for('the submission', lambda: count() >= want)
  wait_for('the turn to finish', lambda: b'$0.50' in state['data'])
  os.write(master, b'\x04')
  status = None
  def exited():
   nonlocal status
   done, status = os.waitpid(pid, os.WNOHANG)
   return done != 0
  wait_for('Ctrl+D to quit', exited)
  state['done'] = True
  return os.waitstatus_to_exitcode(status)
 finally:
  if not state['done']:
   os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
  os.close(master)
print(json.dumps({'exits': [launch(True), launch(False)]}))
`;

const childGuard = new URL("../../atelier-core/test/support/child-guard.ts", import.meta.url).href;

/** Whether this environment can open a pseudo-terminal (a sandbox may have none). */
const ptyAvailable =
	process.platform !== "win32" &&
	spawnSync("python3", ["-c", "import pty; pty.openpty()"], { stdio: "ignore", timeout: 10_000 }).status === 0;

/** The runner a launch executes: the real run() and ProcessTerminal, with a core that records each `session.send`. */
function runnerSource(folder: string, home: string, cwd: string): string {
	const runModule = new URL("../src/run.ts", import.meta.url).href;
	const fakeModule = new URL("../../atelier-core/src/fake-backend.ts", import.meta.url).href;
	return `await import(${JSON.stringify(childGuard)});
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
const { run } = await import(${JSON.stringify(runModule)});
const { FakeBackend } = await import(${JSON.stringify(fakeModule)});
const { ProcessTerminal } = await import(createRequire(${JSON.stringify(runModule)}).resolve("@earendil-works/pi-tui"));
const submitted = ${JSON.stringify(join(folder, "submissions.json"))};
const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const connect = async () => {
	const listeners = new Set();
	writeFileSync(${JSON.stringify(join(folder, "ready"))}, "connected");
	return {
		async request(command) {
			if (command.command === "session.start")
				return { sessionId: "s1", configuration: { backend: "fake", model: "m", permissionMode: "normal", profile: { name: "p", origin: "explicit" }, pending: false } };
			if (command.command === "session.send") {
				let all = [];
				try { all = JSON.parse(readFileSync(submitted, "utf8")); } catch {}
				writeFileSync(submitted, JSON.stringify([...all, command.prompt]), { mode: 0o600 });
				Promise.resolve().then(() => {
					for (const l of listeners) l("s1", { type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.5, seq: 1, turnId: "t1" });
				});
			}
			return {};
		},
		onEvent(l) { listeners.add(l); return () => listeners.delete(l); },
		onExit() { return () => {}; },
		async close() {},
	};
};
const code = await run(["--no-session"], {
	stdin: process.stdin, isTTY: true, cwd: ${JSON.stringify(cwd)}, home: ${JSON.stringify(home)}, env: {}, color: false, tools: [],
	claudeCode: ${JSON.stringify(join(folder, "no-claude"))}, runSecurity: async () => ({ code: 44, stdout: "", stderr: "" }),
	checkLogin: async () => undefined,
	stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t),
	tui: { terminal: new ProcessTerminal(), connect, answerGuardMs: 0, statusIntervalMs: 0 },
	exit: (c) => process.exit(c),
}, () => new FakeBackend([]));
process.exit(code);`;
}

/** Runs the Python driver without blocking the worker; it is killed only if it outlives its own deadline. */
function runDriver(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
	return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn("python3", args, {
			env,
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: (PROBE_BUDGET_S + 3) * 1000,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

it.skipIf(!ptyAvailable)(
	"a second launch in the same home and directory recalls the prompt the first one submitted",
	async () => {
		const repo = fileURLToPath(new URL("../../", import.meta.url));
		const folder = await mkdtemp(join(repo, ".test-history-pty-"));
		try {
			await chmod(folder, 0o700);
			const home = join(folder, "home");
			const cwd = join(folder, "project");
			await mkdir(home);
			await mkdir(cwd);
			const runner = join(folder, "runner.mjs");
			await writeFile(runner, runnerSource(folder, home, cwd), { mode: 0o600 });
			const result = await runDriver(
				["-I", "-c", driver, process.execPath, runner, folder, String(PROBE_BUDGET_S)],
				{
					PATH: process.env.PATH,
					HOME: home,
					TMPDIR: folder,
					TERM: "xterm-256color",
					NO_UPDATE_NOTIFIER: "1",
					NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
				},
				folder,
			);
			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout)).toEqual({ exits: [0, 0] });
			expect(JSON.parse(await readFile(join(folder, "submissions.json"), "utf8"))).toEqual([PROMPT, PROMPT]);
		} finally {
			await rm(folder, { recursive: true, force: true });
		}
	},
	30000,
);
