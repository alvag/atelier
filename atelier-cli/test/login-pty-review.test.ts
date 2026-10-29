import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { requireIsolatedHome } from "../../atelier-core/test/support/login-isolation.ts";

requireIsolatedHome();

// A real PTY, but only inert API-key input or an injected fake Claude process.
// No real Claude binary, credential file, Keychain or network is used.
const driver = String.raw`
import os, pty, sys, json, time, select, termios, signal
node, runner, mode, folder, budget = sys.argv[1:]
# One deadline for the whole probe: the CLI's cold start grows with the machine's load, and no step is timed.
began = time.monotonic()
deadline = began+float(budget)
marker = b'REVIEW_CANARY_NOT_A_CREDENTIAL'
redirect = os.path.join(folder,'stdout.txt')
pid, master = pty.fork()
if pid == 0:
 if mode == 'redirect':
  fd = os.open(redirect, os.O_CREAT|os.O_WRONLY|os.O_TRUNC, 0o600); os.dup2(fd,1); os.close(fd)
 os.execv(node, [node,runner])
data = b''
finished = False
result = {}
def pump():
 global data
 if select.select([master],[],[],0.02)[0]:
  try: data += os.read(master,65536)
  except OSError: pass
def shown():
 if mode == 'redirect':
  try:
   with open(redirect,'rb') as f: return f.read()
  except FileNotFoundError: return b''
 return data
def wait_for(what, check):
 while time.monotonic()<deadline:
  pump()
  if check(): return
 raise RuntimeError('PTY condition timed out after %.1f s: %s' % (time.monotonic()-began, what))
try:
 if mode == 'handoff':
  wait_for('the prompt', lambda: b'> ' in data)
  os.write(master,b'/login account anthropic\r')
  wait_for('the fake Claude Code', lambda: os.path.exists(os.path.join(folder,'fake-started')))
  attrs = termios.tcgetattr(master)
  result['child_cooked'] = bool(attrs[3]&termios.ECHO) and bool(attrs[3]&termios.ICANON)
  os.write(master,b'\x03')
  wait_for('the sign-in outcome', lambda: b'Claude Code is still not logged in' in data)
  result['parent_resumed_raw'] = not bool(termios.tcgetattr(master)[3]&termios.ICANON)
  os.write(master,b'/exit\r')
 else:
  wait_for('the key question', lambda: b'API key (hidden):' in shown())
  result['echo_disabled'] = not bool(termios.tcgetattr(master)[3]&termios.ECHO)
  if mode == 'redirect': os.write(master,marker+b'\r')
  else:
   os.write(master,b'\x1b[200~'+marker+b'\x1b[201~')
   pump(); os.write(master,b'\x03')
 status = None
 while time.monotonic()<deadline:
  pump()
  done, status = os.waitpid(pid, os.WNOHANG)
  if done:
   finished = True; break
 if not finished: raise RuntimeError('PTY child did not exit')
 for _ in range(5): pump()
 result['exit'] = os.waitstatus_to_exitcode(status)
 result['echo_leaked'] = marker in data
 result['restored'] = bool(termios.tcgetattr(master)[3]&termios.ECHO) and bool(termios.tcgetattr(master)[3]&termios.ICANON)
 print(json.dumps(result))
finally:
 if not finished:
  os.kill(pid,signal.SIGKILL); os.waitpid(pid,0)
 os.close(master)
`;

/** The driver's own deadline for a whole probe, under the test's 30 s: the driver always ends and kills its child first. */
const PROBE_BUDGET_S = 25;

const childGuard = new URL("../../atelier-core/test/support/child-guard.ts", import.meta.url).href;

/** Whether this environment can open a pseudo-terminal (a sandbox may have none); the probes need one. */
const ptyAvailable =
	process.platform !== "win32" &&
	spawnSync("python3", ["-c", "import pty; pty.openpty()"], { stdio: "ignore", timeout: 10_000 }).status === 0;

async function probe(mode: "redirect" | "cancel" | "handoff") {
	const folder = await mkdtemp(join(tmpdir(), "login-pty-"));
	const home = join(folder, "home");
	await mkdir(home);
	const fake = join(folder, "claude.cjs");
	await writeFile(
		fake,
		`#!${process.execPath}\nconst fs=require('node:fs'); if(process.argv[3]==='status'){console.log(JSON.stringify({loggedIn:false,authMethod:'none'}));process.exit(1);} fs.writeFileSync(${JSON.stringify(join(folder, "fake-started"))},'started'); process.on('SIGINT',()=>process.exit(130)); process.stdin.resume();`,
	);
	await chmod(fake, 0o755);
	const runner = join(folder, "runner.mjs");
	const runModule = new URL("../src/run.ts", import.meta.url).href;
	const fakeModule = new URL("../../atelier-core/src/fake-backend.ts", import.meta.url).href;
	const injectedRunner = `import { run } from ${JSON.stringify(runModule)}; import { FakeBackend } from ${JSON.stringify(fakeModule)};
 const code=await run(${JSON.stringify(mode === "handoff" ? ["--no-session"] : ["login", "api-key", "anthropic"])}, {stdin:process.stdin,isTTY:true,cwd:${JSON.stringify(folder)},home:${JSON.stringify(home)},env:process.env,color:false,tools:[],claudeCode:${JSON.stringify(fake)},stdout:t=>process.stdout.write(t),stderr:t=>process.stderr.write(t),...(process.stdout.isTTY?{setRawMode:on=>process.stdin.setRawMode(on)}:{}),onInterrupt:h=>{process.on('SIGINT',h);return()=>process.off('SIGINT',h);},exit:c=>process.exit(c)},()=>new FakeBackend([],'claude-code'));
 process.exit(code);`;
	const mainModule = new URL("../src/main.ts", import.meta.url).href;
	// The child gets the credential guard first: it exits with 99 if anything runs the real Claude Code or Keychain.
	const guard = `await import(${JSON.stringify(childGuard)});\n`;
	await writeFile(
		runner,
		guard +
			(mode === "handoff"
				? injectedRunner
				: `process.argv=[process.execPath,'atelier','login','api-key','anthropic']; await import(${JSON.stringify(mainModule)});`),
	);
	const result = await runDriver(["-c", driver, process.execPath, runner, mode, folder, String(PROBE_BUDGET_S)], {
		PATH: process.env.PATH,
		HOME: home,
		TMPDIR: process.env.TMPDIR,
		NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE,
		NO_UPDATE_NOTIFIER: "1",
	});
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}

/** Runs the Python driver without blocking the worker; it is killed only if it outlives its own deadline. */
function runDriver(
	args: string[],
	env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("python3", args, {
			env,
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
	"(e) hides a key even when stdout is redirected but stdin is a terminal",
	async () => {
		// The probe never blocks the test worker: its timers, and Vitest's own timeout, keep running meanwhile.
		let ticks = 0;
		const ticking = setInterval(() => ticks++, 50);
		const result = await probe("redirect").finally(() => clearInterval(ticking));
		expect(ticks).toBeGreaterThan(0);
		expect(result).toEqual({ echo_disabled: true, exit: 0, echo_leaked: false, restored: true });
	},
	30000,
);
it.skipIf(!ptyAvailable)(
	"(e) pasting then Ctrl+C never echoes and restores the actual terminal",
	async () => {
		const result = await probe("cancel");
		expect(result).toEqual({ echo_disabled: true, exit: 130, echo_leaked: false, restored: true });
	},
	30000,
);
it.skipIf(!ptyAvailable)(
	"(d) fake child gets a cooked terminal, Ctrl+C stops only it, line session resumes raw",
	async () => {
		const result = await probe("handoff");
		expect(result).toEqual({
			child_cooked: true,
			parent_resumed_raw: true,
			exit: 0,
			echo_leaked: false,
			restored: true,
		});
	},
	30000,
);
