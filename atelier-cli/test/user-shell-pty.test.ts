import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { requireIsolatedHome } from "../../atelier-core/test/support/login-isolation.ts";

requireIsolatedHome();

// A real pseudo-terminal: the node parent owns a controlling terminal, and the command `runUserShell` starts must not.
// Only an inert shell script runs; no credential, Keychain or network is used.
const driver = `
import os, pty, sys, time, select
node, runner, budget = sys.argv[1:]
deadline = time.monotonic()+float(budget)
pid, master = pty.fork()
if pid == 0:
 os.execv(node, [node, runner])
data = b''
status = None
while time.monotonic() < deadline:
 if select.select([master],[],[],0.02)[0]:
  try: data += os.read(master,65536)
  except OSError: pass
 done, st = os.waitpid(pid, os.WNOHANG)
 if done:
  status = st; break
if status is None:
 os.kill(pid, 9); os.waitpid(pid, 0)
 sys.stderr.write('PTY child did not exit in time'); sys.exit(3)
while select.select([master],[],[],0.05)[0]:
 try:
  chunk = os.read(master,65536)
 except OSError: break
 if not chunk: break
 data += chunk
sys.stdout.write(data.decode('utf8','replace'))
sys.exit(os.waitstatus_to_exitcode(status))
`;

const PROBE_BUDGET_S = 25;

const ptyAvailable =
	process.platform !== "win32" &&
	spawnSync("python3", ["-c", "import pty; pty.openpty()"], { stdio: "ignore", timeout: 10_000 }).status === 0;

let folder: string;
beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "user-shell-pty-"));
});
afterEach(async () => {
	await rm(folder, { recursive: true, force: true });
});

function runDriver(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("python3", ["-I", "-c", driver, ...args], {
			env: { PATH: process.env.PATH, HOME: folder, TMPDIR: process.env.TMPDIR, NO_UPDATE_NOTIFIER: "1" },
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
	"runUserShell's command has stdin at EOF and no controlling terminal, though its parent has one",
	async () => {
		const childGuard = new URL("../../atelier-core/test/support/child-guard.ts", import.meta.url).href;
		const module = new URL("../src/tui/user-shell.ts", import.meta.url).href;
		const command = [
			'if read line; then echo "stdin=data"; else echo "stdin=eof"; fi',
			'if (: </dev/tty) 2>/dev/null; then echo "tty=open"; else echo "tty=denied"; fi',
			'if [ -t 0 ]; then echo "istty=yes"; else echo "istty=no"; fi',
		].join("; ");
		const runner = join(folder, "runner.mjs");
		await writeFile(
			runner,
			`await import(${JSON.stringify(childGuard)});
import { openSync, closeSync } from "node:fs";
import { runUserShell } from ${JSON.stringify(module)};
let parentTty = "denied";
try { closeSync(openSync("/dev/tty", "r+")); parentTty = "open"; } catch {}
const live = [];
const result = await runUserShell(${JSON.stringify(command)}, { cwd: ${JSON.stringify(folder)}, onOutput: (text) => live.push(text) });
process.stdout.write("\\nRESULT " + JSON.stringify({ parentTty, parentStdinIsTty: process.stdin.isTTY === true, exitCode: result.exitCode, output: result.output, live: live.join("") }) + "\\n");
`,
		);
		const done = await runDriver([process.execPath, runner, String(PROBE_BUDGET_S)]);
		expect(done.status, done.stderr + done.stdout).toBe(0);
		const line = done.stdout.split(/\r?\n/).find((text) => text.startsWith("RESULT "));
		expect(line, done.stdout).toBeDefined();
		const result = JSON.parse((line as string).slice("RESULT ".length));
		expect(result.parentTty).toBe("open");
		expect(result.parentStdinIsTty).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.output.split("\n").filter(Boolean)).toEqual(["stdin=eof", "tty=denied", "istty=no"]);
		expect(result.live).toBe(result.output);
	},
	30000,
);
