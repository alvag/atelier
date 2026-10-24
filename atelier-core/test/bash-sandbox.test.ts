import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/tools/bash.ts";
import { Sandbox } from "../src/tools/sandbox.ts";

const onMac = process.platform === "darwin";

let base: string;
let cwd: string;
let temp: string;
let outside: string;
let home: string;
let sandbox: Sandbox;

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-bash-sandbox-")));
	cwd = join(base, "work");
	temp = join(base, "temp");
	outside = join(base, "outside");
	home = join(base, "home");
	for (const dir of [cwd, temp, outside, join(home, ".ssh")]) await mkdir(dir, { recursive: true });
	await writeFile(join(home, ".ssh", "id_rsa"), "FAKE-PRIVATE-KEY\n");
	await writeFile(join(home, "notes.txt"), "ordinary file\n");
	sandbox = new Sandbox({ home, tempDir: temp });
});

afterEach(async () => {
	await sandbox.reset();
	await rm(base, { recursive: true, force: true });
});

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

describe.skipIf(!onMac)("the agent's bash in the sandbox", () => {
	const agent = () => createBashTool({ sandbox });
	const run = (command: string) => agent().execute({ command }, { cwd });

	it("writes inside the working directory and the temporary directory", async () => {
		const result = await run(`echo in-cwd > note.txt && echo in-temp > ${temp}/note.txt`);
		expect(result.ok).toBe(true);
		expect(await readFile(join(cwd, "note.txt"), "utf8")).toBe("in-cwd\n");
		expect(await readFile(join(temp, "note.txt"), "utf8")).toBe("in-temp\n");
	});

	it("writes in the session scratch directory", async () => {
		const scratch = join(base, "scratch");
		await mkdir(scratch);
		const result = await agent().execute({ command: `echo s > ${scratch}/note.txt` }, { cwd, scratchDir: scratch });
		expect(result.ok).toBe(true);
		expect(await exists(join(scratch, "note.txt"))).toBe(true);
	});

	it("cannot write a file outside the working directory and the temporary directory", async () => {
		const result = await run(`echo escaped > ${outside}/file.txt`);
		expect(result.ok).toBe(false);
		expect(result.output).toMatch(/Operation not permitted/);
		expect(await exists(join(outside, "file.txt"))).toBe(false);
	});

	it("cannot write the secret files of the project, at any depth", async () => {
		await mkdir(join(cwd, "sub"));
		const result = await run("for f in .env .env.local sub/.env a.pem sub/b.key; do echo x > $f; done");
		expect(result.ok).toBe(false);
		for (const file of [".env", ".env.local", "sub/.env", "a.pem", "sub/b.key"])
			expect(await exists(join(cwd, file))).toBe(false);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(5);
		// Other files keep working.
		expect((await run("echo x > .envrc && echo x > sub/notes.txt")).ok).toBe(true);
	});

	it("cannot read the user's secrets, but reads the rest of the home directory", async () => {
		const secret = await run(`cat ${home}/.ssh/id_rsa`);
		expect(secret.ok).toBe(false);
		expect(secret.output).not.toContain("FAKE-PRIVATE-KEY");
		expect(secret.output).toMatch(/Operation not permitted/);
		const ordinary = await run(`cat ${home}/notes.txt`);
		expect(ordinary.output).toContain("ordinary file");
	});

	it("reaches a server on the local network: the network is not restricted", async () => {
		const server = await serve();
		try {
			const result = await run(`curl -sS --max-time 5 http://127.0.0.1:${port(server.server)}/`);
			expect(result.ok).toBe(true);
			expect(result.output).toContain("served");
			expect(server.hits()).toBe(1);
		} finally {
			server.server.close();
		}
	});

	it("keeps the filtered environment, the exit code and the working directory", async () => {
		const previous = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "sk-secret";
		try {
			const result = await run('pwd; echo "[$ANTHROPIC_API_KEY]"; exit 3');
			expect(result.output).toContain(`${cwd}\n[]`);
			expect(result.output).toContain("[exit code 3]");
		} finally {
			if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previous;
		}
	});

	it("still stops a command at its timeout and on abort, leaving no process behind", async () => {
		const timedOut = await agent().execute({ command: "sleep 30", timeoutSec: 1 }, { cwd });
		expect(timedOut.ok).toBe(false);
		expect(timedOut.output).toContain("[command timed out after 1s]");

		const controller = new AbortController();
		const running = agent().execute({ command: "sleep 30" }, { cwd, signal: controller.signal });
		setTimeout(() => controller.abort(), 300);
		expect((await running).output).toContain("[command aborted]");
	});

	it("does not ask for approval differently: the main agent's bash still asks", () => {
		expect(agent().approvalCommand({ command: "ls" })).toBe("ls");
	});
});

describe.skipIf(!onMac)("the verifier's bash in the sandbox", () => {
	let verifierDir: string;
	const verifier = () => createBashTool({ withoutApproval: true, policy: "verifier", sandbox });
	const run = (command: string) => verifier().execute({ command }, { cwd: verifierDir });

	beforeEach(async () => {
		verifierDir = join(base, "verify");
		await mkdir(join(verifierDir, "candidate"), { recursive: true });
		await writeFile(join(verifierDir, "candidate", "dep.js"), "module.exports = 41;\n");
		await writeFile(join(outside, "secret.txt"), "OUTSIDE-SECRET\n");
	});

	it("runs the project's tools on the copied files, without asking", async () => {
		expect(verifier().approvalCommand({ command: "ls" })).toBeUndefined();
		const result = await run("cd candidate && node -e 'console.log(require(\"./dep.js\") + 1)' && ls | head -1");
		expect(result.ok).toBe(true);
		expect(result.output).toContain("42\ndep.js");
	});

	it("writes only inside its own directory", async () => {
		expect((await run("echo ok > candidate/out.txt && echo ok > scratch.txt")).ok).toBe(true);
		expect(await exists(join(verifierDir, "scratch.txt"))).toBe(true);

		const attempt = await run(
			`echo escaped > ${outside}/file.txt; echo escaped > ${temp}/file.txt; echo e > ${home}/file.txt`,
		);
		expect(attempt.ok).toBe(false);
		expect(attempt.output.match(/Operation not permitted/g)).toHaveLength(3);
		expect(await exists(join(outside, "file.txt"))).toBe(false);
		expect(await exists(join(temp, "file.txt"))).toBe(false);
		expect(await exists(join(home, "file.txt"))).toBe(false);
	});

	it("reads nothing outside its directory and the toolchain, not even a file next to it", async () => {
		const result = await run(`cat ${outside}/secret.txt; cat ${home}/.ssh/id_rsa; cat ${home}/notes.txt; ls ${base}`);
		expect(result.ok).toBe(false);
		expect(result.output).not.toContain("OUTSIDE-SECRET");
		expect(result.output).not.toContain("FAKE-PRIVATE-KEY");
		expect(result.output).not.toContain("ordinary file");
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(4);
	});

	it("has no network: not a local server, not a name lookup", async () => {
		const server = await serve();
		try {
			const local = await run(`curl -sS --max-time 3 http://127.0.0.1:${port(server.server)}/`);
			expect(local.ok).toBe(false);
			expect(local.output).not.toContain("served");
			expect(server.hits()).toBe(0);

			const lookup = await run(
				"node -e \"require('dns').lookup('example.com', (error, address) => { console.log(error ? error.code : address); process.exit(error ? 1 : 0); })\"",
			);
			expect(lookup.ok).toBe(false);
			expect(lookup.output).toMatch(/ENOTFOUND|EAI_AGAIN/);
		} finally {
			server.server.close();
		}
	});
});

describe("without a sandbox", () => {
	const unavailable = () => new Sandbox({ platform: "linux" });

	it("the agent's bash runs unsandboxed", async () => {
		const result = await createBashTool({ sandbox: unavailable() }).execute(
			{ command: `echo free > ${join(base, "outside", "free.txt")}` },
			{ cwd },
		);
		expect(result.ok).toBe(true);
		expect(await exists(join(outside, "free.txt"))).toBe(true);
	});

	it("the verifier's bash refuses to run", async () => {
		const result = await createBashTool({ withoutApproval: true, policy: "verifier", sandbox: unavailable() }).execute(
			{ command: `echo free > ${join(base, "outside", "free.txt")}` },
			{ cwd },
		);
		expect(result.ok).toBe(false);
		expect(result.output).toBe("[bash is not available: sandbox not available on this platform]");
		expect(await exists(join(outside, "free.txt"))).toBe(false);
	});
});

/** A local HTTP server that counts the requests it answers. */
async function serve(): Promise<{ server: Server; hits: () => number }> {
	let count = 0;
	const server = createServer((_request, response) => {
		count++;
		response.end("served");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, hits: () => count };
}

const port = (server: Server) => (server.address() as AddressInfo).port;
