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
// text] (in the output of this launch), ["turns", n] (the TUI's OSC 7501 root reports went from working to done n
// times in this launch: the turn ended in the TUI, not only in the core) or ["exit"] (Ctrl+D, which waits for no turn).
const driver = String.raw`
import os, pty, sys, json, time, select, signal, re
node, guard, main, folder, budget, script = sys.argv[1:]
began = time.monotonic()
deadline = began+float(budget)
def turns(data):
 states = [r.split(b':')[0] for r in re.findall(rb'\x1b\]7501;([^\x1b\x07]*)', data) if b':id=' not in r]
 return sum(1 for a, b in zip(states, states[1:]) if a == b'state=working' and b in (b'state=done', b'state=idle'))
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
   elif step[0] == 'turns': wait_for('%d turns' % step[1], lambda: turns(state['data']) >= step[1])
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
		// The TUI reports its state to the terminal without asking it first.
		PI_PROGRAM_STATUS: "1",
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

interface SavedEntry {
	type: string;
	text?: string;
	mode?: string;
}

/** The entries of each saved session of the home; none when nothing was saved. */
async function savedSessions(): Promise<SavedEntry[][]> {
	const root = join(folder, "home", ".atelier", "sessions");
	const sessions: SavedEntry[][] = [];
	for (const key of await readdir(root).catch(() => []))
		for (const file of await readdir(join(root, key))) {
			if (!file.endsWith(".jsonl")) continue;
			const lines = (await readFile(join(root, key, file), "utf8")).split("\n").filter((line) => line !== "");
			sessions.push(lines.map((line) => JSON.parse(line) as SavedEntry));
		}
	return sessions;
}

/** The states of the TUI's OSC 7501 root reports in `output`, in order; a child's report carries an id. */
function rootStates(output: string): string[] {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: OSC 7501 records, ended by ESC or BEL.
	const records = [...output.matchAll(/\x1b\]7501;([^\x1b\x07]*)/g)].map((match) => match[1] ?? "");
	return records.filter((record) => !record.includes(":id=")).map((record) => record.split(":")[0]?.slice(6) ?? "");
}

/** The prompts each saved session of the home holds, in order. */
async function savedPrompts(): Promise<string[][]> {
	return (await savedSessions()).map((entries) =>
		entries.filter((entry) => entry.type === "prompt").map((entry) => entry.text ?? ""),
	);
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
		// The TUI reports itself idle before the message makes it work, as it does before a typed one.
		expect(rootStates(launch?.output ?? "").slice(0, 2)).toEqual(["idle", "working"]);
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

it.skipIf(!ptyAvailable)(
	"atelier --continue -i sends the message to the resumed session, with the options given before -i",
	async () => {
		const [first, second] = await drive([
			{ args: ["-i", "inert first"], steps: [["turns", 1], ["exit"]] },
			{ args: ["--continue", "--mode", "auto", "-i", "inert again"], steps: [["turns", 1], ["exit"]] },
		]);
		expect([first?.exit, second?.exit]).toEqual([0, 0]);
		const sessions = await savedSessions();
		expect(await savedPrompts()).toEqual([["inert first", "inert again"]]);
		expect(sessions[0]?.filter((entry) => entry.type === "config").at(-1)?.mode).toBe("auto");
	},
	(PROBE_BUDGET_S + 5) * 1000,
);

it.skipIf(!ptyAvailable)(
	"atelier -i runs a slash command as if typed, without naming the session",
	async () => {
		const [launch] = await drive([
			{
				args: ["-i", "/mode auto"],
				steps: [["screen", "mode: auto (this session)"], ["send", "inert after"], ["turns", 1], ["exit"]],
			},
		]);
		expect(launch?.exit).toBe(0);
		expect(await savedPrompts()).toEqual([["inert after"]]);
		expect(launch?.output).not.toContain("Atelier - /mode");
		expect(launch?.output).toContain("Atelier - inert after - project");
	},
	(PROBE_BUDGET_S + 5) * 1000,
);

it("atelier -i without a terminal exits 2 with the error and starts no session", async () => {
	const result = spawnSync(process.execPath, ["--import", childGuard, main, "-i", "inert"], {
		cwd: join(folder, "project"),
		env: binaryEnv(),
		stdio: ["pipe", "pipe", "pipe"],
		encoding: "utf8",
		timeout: 15_000,
	});
	expect(result.status).toBe(2);
	expect(result.stderr).toBe(
		"error: --prompt-interactive needs the terminal interface: stdin and stdout must be terminals, and ATELIER_TUI not off.\n",
	);
	expect(result.stdout).toBe("");
	expect(await savedSessions()).toEqual([]);
});
