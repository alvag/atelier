import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { requireIsolatedHome } from "../../atelier-core/test/support/login-isolation.ts";

requireIsolatedHome();

// The real binary in a real PTY: main.ts, its TUI and the core it starts. The core runs the echo backend, which answers
// "echo: <prompt>" without network or credentials.
const PROBE_BUDGET_S = 40;

// Every step waits for a condition under one deadline, none for a fixed time. A step is ["send", text], ["screen",
// text] (in the output of this launch), ["turns", n] (turn_finished events saved in the home) or ["exit"] (Ctrl+D).
const driver = String.raw`
import os, pty, sys, json, time, select, signal, glob
node, guard, main, folder, budget, script = sys.argv[1:]
began = time.monotonic()
deadline = began+float(budget)
sessions = os.path.join(folder,'home','.atelier','sessions','*','*.jsonl')
def turns():
 total = 0
 for path in glob.glob(sessions):
  with open(path) as f:
   total += sum(1 for line in f if '"type":"turn_finished"' in line)
 return total
def launch(args, steps):
 pid, master = pty.fork()
 if pid == 0:
  os.chdir(os.path.join(folder,'project'))
  os.execv(node, [node,'--import',guard,main]+args)
 state = {'data': b'', 'done': False, 'status': None}
 def wait_for(what, check):
  while time.monotonic()<deadline:
   if select.select([master],[],[],0.02)[0]:
    try: state['data'] += os.read(master,65536)
    except OSError: pass
   if check(): return
  raise RuntimeError('PTY condition timed out after %.1f s: %s\n%s' % (time.monotonic()-began, what, state['data'][-400:]))
 def exited():
  done, status = os.waitpid(pid, os.WNOHANG)
  if done != 0: state['status'] = status
  return done != 0
 try:
  # Bracketed paste is on once the TUI has started.
  wait_for('the TUI', lambda: b'\x1b[?2004h' in state['data'])
  for step in steps:
   if step[0] == 'send': os.write(master, step[1].encode()+b'\r')
   elif step[0] == 'screen': wait_for(step[1], lambda: step[1].encode() in state['data'])
   elif step[0] == 'turns': wait_for('%d turns' % step[1], lambda: turns() >= step[1])
   elif step[0] == 'exit':
    os.write(master, b'\x04')
    wait_for('Ctrl+D to quit', exited)
    state['done'] = True
  return {'exit': os.waitstatus_to_exitcode(state['status']) if state['done'] else None, 'output': state['data'].decode('utf-8','replace')}
 finally:
  if not state['done']:
   os.kill(pid, signal.SIGKILL); os.waitpid(pid, 0)
  os.close(master)
print(json.dumps([launch(l['args'], l['steps']) for l in json.loads(script)]))
`;

const repo = fileURLToPath(new URL("../../", import.meta.url));
const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const childGuard = new URL("../../atelier-core/test/support/child-guard.ts", import.meta.url).href;

/** Whether this environment can open a pseudo-terminal (a sandbox may have none). */
const ptyAvailable =
	process.platform !== "win32" &&
	spawnSync("python3", ["-c", "import pty; pty.openpty()"], { stdio: "ignore", timeout: 10_000 }).status === 0;

type Step = ["send", string] | ["screen", string] | ["turns", number] | ["exit"];
interface Launch {
	args: string[];
	steps: Step[];
}

let folder: string;
beforeEach(async () => {
	folder = await mkdtemp(join(repo, ".test-prompt-interactive-"));
	await chmod(folder, 0o700);
	await mkdir(join(folder, "home"));
	await mkdir(join(folder, "project"));
});
afterEach(async () => {
	await rm(folder, { recursive: true, force: true });
});

/** The environment of the binary: the echo backend, nothing that asks a service, and the test's own home. */
function binaryEnv(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: join(folder, "home"),
		TMPDIR: folder,
		TERM: "xterm-256color",
		NO_COLOR: "1",
		NO_UPDATE_NOTIFIER: "1",
		NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
		ATELIER_BACKEND: "echo",
		ATELIER_ECHO_SESSIONS: "on",
		ATELIER_LOGIN_CHECK: "off",
		ATELIER_MEMORY: "off",
		ATELIER_MCP: "off",
		ATELIER_MODEL_REFRESH: "off",
		ATELIER_OFFLINE: "1",
	};
}

/** Runs the launches one after the other in the same home and project; each answers its exit code and its output. */
function drive(launches: Launch[]) {
	return new Promise<{ exit: number | null; output: string }[]>((resolve, reject) => {
		const args = ["-I", "-c", driver, process.execPath, childGuard, main, folder, String(PROBE_BUDGET_S)];
		const child = spawn("python3", [...args, JSON.stringify(launches)], {
			env: binaryEnv(),
			cwd: folder,
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
		child.on("close", (status) =>
			status === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`driver exited ${status}: ${stderr}`)),
		);
	});
}

/** The prompts each saved session of the home holds, in order. */
async function savedPrompts(): Promise<string[][]> {
	const root = join(folder, "home", ".atelier", "sessions");
	const sessions: string[][] = [];
	for (const key of await readdir(root))
		for (const file of await readdir(join(root, key))) {
			if (!file.endsWith(".jsonl")) continue;
			const lines = (await readFile(join(root, key, file), "utf8")).split("\n").filter((line) => line !== "");
			const entries = lines.map((line) => JSON.parse(line) as { type: string; text?: string });
			sessions.push(entries.filter((entry) => entry.type === "prompt").map((entry) => entry.text ?? ""));
		}
	return sessions;
}

it.skipIf(!ptyAvailable)(
	"atelier -i submits the prompt once, finishes the turn and stays open for the next one",
	async () => {
		const [launch] = await drive([
			{
				args: ["-i", "inert first message"],
				steps: [
					["turns", 1],
					["screen", "echo: inert first message"],
					["send", "inert second"],
					["turns", 2],
					["exit"],
				],
			},
		]);
		expect(launch?.exit).toBe(0);
		expect(await savedPrompts()).toEqual([["inert first message", "inert second"]]);
		// It names the session in the terminal's title, as a typed first prompt does.
		expect(launch?.output).toContain("Atelier - inert first message - project");
	},
	(PROBE_BUDGET_S + 5) * 1000,
);

it.skipIf(!ptyAvailable)(
	"atelier --prompt-interactive sends a text of several lines as one message",
	async () => {
		const [launch] = await drive([
			{ args: ["--prompt-interactive", "line one\nline two"], steps: [["turns", 1], ["exit"]] },
		]);
		expect(launch?.exit).toBe(0);
		expect(await savedPrompts()).toEqual([["line one\nline two"]]);
	},
	(PROBE_BUDGET_S + 5) * 1000,
);
