import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { requireIsolatedHome } from "../../atelier-core/test/support/login-isolation.ts";

requireIsolatedHome();

// The real binary and core in a PTY, with a test-only failing backend (no network or credentials).
// The printed command must reopen the saved session even when its only turn failed.
const PROBE_BUDGET_S = 40;

// Every step waits for a condition under one deadline, none for a fixed time. A step is ["send", text], ["screen",
// text] (in the output of this launch), ["turns", n] (the TUI's OSC 7501 root reports went from working to settled n
// times in this launch: the turn ended in the TUI, not only in the core) or ["exit"] (Ctrl+D, which waits for no turn).
const driver = String.raw`
import os, pty, sys, json, time, select, signal, re
node, guard, main, folder, budget, script = sys.argv[1:]
began = time.monotonic()
deadline = began+float(budget)
def turns(data):
 states = [r.split(b':')[0] for r in re.findall(rb'\x1b\]7501;([^\x1b\x07]*)', data) if b':id=' not in r]
 return sum(1 for a, b in zip(states, states[1:]) if a == b'state=working' and b in (b'state=done', b'state=idle', b'state=error'))
def launch(args, steps):
 pid, master = pty.fork()
 if pid == 0:
  os.chdir(os.path.join(folder,'project'))
  os.execv(node, [node,'--import',guard,main]+args)
 state = {'data': b'', 'done': False, 'status': None}
 def wait_for(what, check, limit=None):
  end = deadline if limit is None else min(deadline, time.monotonic()+limit)
  while time.monotonic()<end:
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
   elif step[0] == 'fifo':
    # The saved turn is on disk: replace the file with a FIFO nobody ever opens for writing.
    def saved():
     for d, _, names in os.walk(os.path.join(folder,'home','.atelier','sessions')):
      for n in names:
       if n.endswith('.jsonl') and b'turn_finished' in open(os.path.join(d,n),'rb').read(): return os.path.join(d,n)
    wait_for('the saved turn', lambda: saved() is not None)
    path = saved(); os.unlink(path); os.mkfifo(path)
   elif step[0] in ('exit', 'signal'):
    # The last element bounds the wait: the real process must be gone by then, not merely have called process.exit.
    grace = step[-1] if len(step) > (2 if step[0] == 'signal' else 1) else None
    if step[0] == 'signal': os.kill(pid, step[1])
    else: os.write(master, b'\x04')
    wait_for('the real process to exit within %s s' % grace, exited, grace)
    state['done'] = True
  return {'exit': os.waitstatus_to_exitcode(state['status']) if state['done'] else None, 'output': state['data'].decode('utf-8','replace')}
 finally:
  if not state['done']:
   # pty.fork made the child a session and process group leader: kill it and anything it left behind.
   for target in (os.killpg, os.kill):
    try: target(pid, signal.SIGKILL)
    except OSError: pass
   os.waitpid(pid, 0)
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

type Step =
	| ["send", string]
	| ["screen", string]
	| ["turns", number]
	| ["fifo"]
	| ["signal", number, number?]
	| ["exit", number?];
interface Launch {
	args: string[];
	steps: Step[];
}

let folder: string;
beforeEach(async () => {
	folder = await mkdtemp(join(repo, ".test-resume-hint-"));
	await chmod(folder, 0o700);
	await mkdir(join(folder, "home"));
	await mkdir(join(folder, "project"));
	await mkdir(join(folder, "other"));
	await writeFile(
		join(folder, "backend.mjs"),
		`import { EchoBackend } from ${JSON.stringify(new URL("../../atelier-core/src/server/echo-backend.ts", import.meta.url).href)};
import { FakeBackend } from ${JSON.stringify(new URL("../../atelier-core/src/fake-backend.ts", import.meta.url).href)};
EchoBackend.prototype.start = function(options) {
	return new FakeBackend([[{ throw: "fixture turn failed" }]], this.id).start(options);
};
const errno = process.env.ATELIER_TEST_STDOUT_ERROR;
if (errno) {
	const write = process.stdout.write.bind(process.stdout);
	process.stdout.write = (chunk, ...rest) => {
		if (typeof chunk === "string" && chunk.startsWith("atelier --resume ")) {
			process.nextTick(() => {
				process.stderr.write("fixture stdout " + errno + "\\n");
				process.stdout.emit("error", Object.assign(new Error("closed stdout"), { code: errno }));
			});
			return false;
		}
		return write(chunk, ...rest);
	};
}
`,
	);
});
afterEach(async () => {
	await rm(folder, { recursive: true, force: true });
});

/** The environment of the binary: the echo backend, nothing that asks a service, and the test's own home. */
function binaryEnv(errno?: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH,
		HOME: join(folder, "home"),
		TMPDIR: folder,
		TERM: "xterm-256color",
		NO_COLOR: "1",
		NO_UPDATE_NOTIFIER: "1",
		NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
		NODE_OPTIONS: `--import=${join(folder, "backend.mjs")}`,
		ATELIER_BACKEND: "echo",
		ATELIER_ECHO_SESSIONS: "on",
		ATELIER_LOGIN_CHECK: "off",
		ATELIER_MEMORY: "off",
		ATELIER_MCP: "off",
		ATELIER_MODEL_REFRESH: "off",
		ATELIER_OFFLINE: "1",
		// The TUI reports its state to the terminal without asking it first.
		PI_PROGRAM_STATUS: "1",
		...(errno === undefined ? {} : { ATELIER_TEST_STDOUT_ERROR: errno }),
	};
}

/** Runs the launches one after the other in the same home and project; each answers its exit code and its output. */
function drive(launches: Launch[], errno?: string) {
	return new Promise<{ exit: number | null; output: string }[]>((resolve, reject) => {
		const args = ["-I", "-c", driver, process.execPath, childGuard, main, folder, String(PROBE_BUDGET_S)];
		const child = spawn("python3", [...args, JSON.stringify(launches)], {
			env: binaryEnv(errno),
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
	event?: { type: string; stopReason?: string };
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

/** The prompts each saved session of the home holds, in order. */
async function savedPrompts(): Promise<string[][]> {
	return (await savedSessions()).map((entries) =>
		entries.filter((entry) => entry.type === "prompt").map((entry) => entry.text ?? ""),
	);
}

const FAILED_PROMPT = "inert first turn";

/** The id of the `atelier --resume <id>` line the TUI left on the terminal, a line of its own; none when it printed no. */
function resumeLine(output: string): string | undefined {
	return stripVTControlCharacters(output).match(/^atelier --resume (\S+)\r?$/m)?.[1];
}

it.skipIf(!ptyAvailable)(
	"atelier prints a usable resume command after a failed turn, and resumes without a new turn",
	async () => {
		const [first] = await drive([
			{
				args: ["--mode", "yolo", "--no-sandbox"],
				steps: [["send", FAILED_PROMPT], ["turns", 1], ["exit"]],
			},
		]);
		expect(first?.exit).toBe(0);
		expect((await savedSessions())[0]).toContainEqual(
			expect.objectContaining({ event: expect.objectContaining({ type: "turn_finished", stopReason: "error" }) }),
		);
		const id = resumeLine(first?.output ?? "");
		expect(id, first?.output.slice(-1000)).toBeDefined();
		const [second] = await drive([
			{
				args: ["--resume", id ?? ""],
				steps: [["screen", FAILED_PROMPT], ["exit"]],
			},
		]);
		expect(second?.exit).toBe(0);
		expect(resumeLine(second?.output ?? "")).toBe(id);
		expect(await savedPrompts()).toEqual([[FAILED_PROMPT]]);
	},
	(PROBE_BUDGET_S + 5) * 1000,
);

it.skipIf(!ptyAvailable).each(["relative", "absolute", "same directory"])(
	"offers no unusable resume hint for --cwd (%s)",
	async (kind) => {
		const cwd = kind === "relative" ? "../other" : kind === "absolute" ? join(folder, "other") : ".";
		const [result] = await drive([
			{
				args: ["--cwd", cwd, "--mode", "yolo", "--no-sandbox"],
				steps: [["send", FAILED_PROMPT], ["turns", 1], ["exit"]],
			},
		]);
		expect(result?.exit).toBe(0);
		expect(await savedPrompts()).toEqual([[FAILED_PROMPT]]);
		const id = resumeLine(result?.output ?? "");
		if (kind === "same directory") {
			expect(id).toBeDefined();
			const [resumed] = await drive([{ args: ["--resume", id ?? ""], steps: [["screen", FAILED_PROMPT], ["exit"]] }]);
			expect(resumed?.exit).toBe(0);
		} else expect(id).toBeUndefined();
	},
	(PROBE_BUDGET_S + 5) * 1000,
);

it("documents that only the TUI prints a hint and preserves script output", async () => {
	const docs = await readFile(new URL("../../docs/cli.md", import.meta.url), "utf8");
	expect(docs).toContain("Only the TUI prints");
	expect(docs).toContain("The line-by-line CLI and `--prompt` do not print it, preserving stdout for scripts.");
	expect(docs).toContain("if it expires, no hint is printed and the exit code is unchanged.");
});

it.each([
	["README.md", "The interactive session runs full screen:", "On exit, the TUI prints"],
	["docs/cli.md", "Without a prompt, or with", "Only the TUI prints"],
])("documents the running session's saving status after introducing the TUI in %s", async (file, opening, hint) => {
	const text = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
	expect(text.indexOf(opening)).toBeGreaterThanOrEqual(0);
	expect(text.indexOf(hint)).toBeGreaterThan(text.indexOf(opening));
	expect(text).toContain("A session running without saving prints no hint.");
	expect(text).toContain("Using `/resume` after `--no-session` opens a saved session and prints its hint.");
});

it.skipIf(!ptyAvailable).each([
	[1, "EIO", 129],
	[1, "EPIPE", 129],
	[15, "EIO", 143],
	[15, "EPIPE", 143],
	[15, "EBADF", 1],
])(
	"preserves the appropriate exit status for signal %i and asynchronous stdout %s",
	async (signal, errno, expected) => {
		const [result] = await drive(
			[
				{
					args: ["--mode", "yolo", "--no-sandbox"],
					steps: [
						["send", FAILED_PROMPT],
						["turns", 1],
						["signal", signal],
					],
				},
			],
			errno,
		);
		expect(result?.output).toContain(`fixture stdout ${errno}`);
		expect(result?.exit).toBe(expected);
	},
	(PROBE_BUDGET_S + 5) * 1000,
);

const SHUTDOWN_GRACE_S = 8;

// The saved file becomes a FIFO that has no writer, so reading it never ends. Whatever the TUI does to build a hint
// must not keep the real process alive past the grace, nor print a hint it could not read the session for.
it.skipIf(!ptyAvailable).each([
	["Ctrl+D", 0, ["exit", SHUTDOWN_GRACE_S]],
	["SIGHUP", 129, ["signal", 1, SHUTDOWN_GRACE_S]],
	["SIGTERM", 143, ["signal", 15, SHUTDOWN_GRACE_S]],
] as [string, number, Step][])(
	"terminates the real process on %s when the saved session is an unread FIFO, printing no hint",
	async (_name, expected, quit) => {
		const [result] = await drive([
			{
				args: ["--mode", "yolo", "--no-sandbox"],
				steps: [["send", FAILED_PROMPT], ["turns", 1], ["fifo"], quit],
			},
		]);
		expect(result?.exit).toBe(expected);
		expect(resumeLine(result?.output ?? "")).toBeUndefined();
	},
	(PROBE_BUDGET_S + 5) * 1000,
);
