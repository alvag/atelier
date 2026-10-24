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

	it("cannot write what the library always protects, such as git hooks and shell start-up files, also when the process runs elsewhere", async () => {
		await mkdir(join(cwd, ".git", "hooks"), { recursive: true });
		await mkdir(join(cwd, ".vscode"));
		const result = await run(
			"for f in .git/hooks/pre-commit .git/config .bashrc .gitconfig .vscode/tasks.json; do echo x > $f; done",
		);
		expect(result.ok).toBe(false);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(5);
		for (const file of [".git/hooks/pre-commit", ".git/config", ".bashrc", ".gitconfig", ".vscode/tasks.json"])
			expect(await exists(join(cwd, file))).toBe(false);
		expect((await run("echo x > .git/HEAD")).ok).toBe(true);
	});

	it("cannot read the user's secrets, but reads the rest of the home directory", async () => {
		const secret = await run(`cat ${home}/.ssh/id_rsa`);
		expect(secret.ok).toBe(false);
		expect(secret.output).not.toContain("FAKE-PRIVATE-KEY");
		expect(secret.output).toMatch(/Operation not permitted/);
		const ordinary = await run(`cat ${home}/notes.txt`);
		expect(ordinary.output).toContain("ordinary file");
	});

	it("writes the package managers' caches under the user's home, and still not the home itself", async () => {
		const caches = [
			".npm",
			"Library/pnpm",
			".local/share/pnpm",
			".pnpm-store",
			".yarn",
			".cache/pnpm",
			"Library/Caches/Yarn",
		];
		for (const cache of caches) await mkdir(join(home, cache), { recursive: true });
		const result = await run(caches.map((cache) => `echo ok > ${home}/${cache}/entry`).join(" && "));
		expect(result.ok).toBe(true);
		for (const cache of caches) expect(await exists(join(home, cache, "entry"))).toBe(true);

		const homeItself = await run(`echo x > ${home}/stray.txt; echo x > ${home}/.ssh/authorized_keys`);
		expect(homeItself.ok).toBe(false);
		expect(homeItself.output.match(/Operation not permitted/g)).toHaveLength(2);
		expect(await exists(join(home, "stray.txt"))).toBe(false);
		expect(await exists(join(home, ".ssh", "authorized_keys"))).toBe(false);
	});

	it("lets npm write the cache directory it reports", async () => {
		await mkdir(join(home, ".npm"));
		const npm = createBashTool({ sandbox, env: { HOME: home } });
		const result = await npm.execute(
			{
				command:
					'cache="$(npm config get cache)" && echo "cache=$cache" && mkdir -p "$cache/_cacache" && echo ok > "$cache/_cacache/entry"',
			},
			{ cwd },
		);
		expect(result.output).toContain(`cache=${home}/.npm`);
		expect(result.ok).toBe(true);
		expect(await exists(join(home, ".npm", "_cacache", "entry"))).toBe(true);
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

/**
 * Runs `command` until its result names a cause. The library reads the file
 * denials from the system log, which can lag in the first seconds after it
 * starts, so the same denied command is repeated for a while; the cause itself
 * is what is under test, not how fast the log answers.
 */
async function untilBlocked(tool: ReturnType<typeof createBashTool>, command: string, workDir: string) {
	let result = await tool.execute({ command }, { cwd: workDir });
	for (let attempt = 0; attempt < 30 && !result.output.includes("[sandbox blocked:"); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		result = await tool.execute({ command }, { cwd: workDir });
	}
	return result;
}

describe.skipIf(!onMac)("what the sandbox says it blocked", () => {
	it("names the file a command tried to write", async () => {
		const result = await untilBlocked(createBashTool({ sandbox }), `echo x > ${outside}/file.txt`, cwd);
		expect(result.ok).toBe(false);
		expect(result.output).toContain(`[sandbox blocked: write to ${outside}/file.txt (not an allowed write path)]`);
		expect(result.blocked).toContain(`write to ${outside}/file.txt (not an allowed write path)`);
	}, 30_000);

	it("names the secret a command tried to read", async () => {
		const result = await untilBlocked(createBashTool({ sandbox }), `cat ${home}/.ssh/id_rsa`, cwd);
		expect(result.output).toContain(`[sandbox blocked: read of ${home}/.ssh/id_rsa (denied by the sandbox policy)]`);
		expect(result.output).not.toContain("FAKE-PRIVATE-KEY");
	}, 30_000);

	it("names the connection the verifier tried to make", async () => {
		const server = await serve();
		try {
			const verifier = createBashTool({ withoutApproval: true, policy: "verifier", sandbox });
			const dir = join(base, "verify");
			await mkdir(dir, { recursive: true });
			const result = await untilBlocked(
				verifier,
				`curl -sS --max-time 3 http://127.0.0.1:${port(server.server)}/`,
				dir,
			);
			expect(result.output).toMatch(/\[sandbox blocked: network connect to [^ ]+ \(no network for the verifier\)\]/);
			expect(server.hits()).toBe(0);
		} finally {
			server.server.close();
		}
	}, 30_000);

	it("adds nothing to a command that was not blocked", async () => {
		const result = await createBashTool({ sandbox }).execute({ command: "echo fine; exit 2" }, { cwd });
		expect(result.output).toBe("fine\n\n[exit code 2]");
		expect(result.blocked).toBeUndefined();
	});
});

describe.skipIf(!onMac)("the sandbox configuration files", () => {
	const agent = () => createBashTool({ sandbox });
	const run = (command: string) => agent().execute({ command }, { cwd });
	const configure = async (file: string, config: unknown) => {
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, typeof config === "string" ? config : JSON.stringify(config));
	};

	it("lets the user file add a place to write and a place not to read", async () => {
		await mkdir(join(home, "extra"));
		await configure(join(home, ".atelier", "sandbox.json"), { allowWrite: ["~/extra"], denyRead: ["notes.txt"] });
		const result = await run(`echo ok > ${home}/extra/file.txt`);
		expect(result.ok).toBe(true);
		expect(await exists(join(home, "extra", "file.txt"))).toBe(true);
		expect((await run(`echo no > ${outside}/file.txt`)).ok).toBe(false);
		const denied = await run(`cat ${home}/notes.txt`);
		expect(denied.output).not.toContain("ordinary file");
		expect(denied.output).toMatch(/Operation not permitted/);
	});

	it("lets the project file add a place to write, relative to the working directory", async () => {
		await configure(join(cwd, ".atelier", "sandbox.json"), { allowWrite: ["../outside"] });
		expect((await run(`echo ok > ${outside}/file.txt`)).ok).toBe(true);
		expect(await exists(join(outside, "file.txt"))).toBe(true);
	});

	it("keeps the secret file patterns inside an added directory", async () => {
		await configure(join(cwd, ".atelier", "sandbox.json"), { allowWrite: ["../outside"] });
		const result = await run(`cd ${outside} && echo x > .env; echo x > cert.pem; echo ok > plain.txt`);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(2);
		expect(await exists(join(outside, ".env"))).toBe(false);
		expect(await exists(join(outside, "cert.pem"))).toBe(false);
		expect(await exists(join(outside, "plain.txt"))).toBe(true);
	});

	it("keeps the git hooks of an added directory protected", async () => {
		await mkdir(join(outside, ".git", "hooks"), { recursive: true });
		await configure(join(cwd, ".atelier", "sandbox.json"), { allowWrite: ["../outside"] });
		const result = await run(`echo x > ${outside}/.git/hooks/pre-commit; echo x > ${outside}/.git/config`);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(2);
		expect(await exists(join(outside, ".git", "hooks", "pre-commit"))).toBe(false);
	});

	it("does not let a command change the project's configuration", async () => {
		await configure(join(cwd, ".atelier", "sandbox.json"), {});
		const result = await run(
			`echo '{"allowWrite":["${home}"]}' > .atelier/sandbox.json; rm .atelier/sandbox.json; mv .atelier .atelier-x; mkdir -p .atelier2 && echo ok`,
		);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(3);
		expect(await readFile(join(cwd, ".atelier", "sandbox.json"), "utf8")).toBe("{}");
	});

	it("does not let a command create the user's configuration or write the secrets through it", async () => {
		await configure(join(home, ".atelier", "sandbox.json"), {});
		const result = await run(`echo '{}' > ${home}/.atelier/sandbox.json`);
		expect(result.ok).toBe(false);
		expect(await readFile(join(home, ".atelier", "sandbox.json"), "utf8")).toBe("{}");
	});

	it("stops the command with the file and the problem when a file is invalid, instead of ignoring it", async () => {
		await configure(join(cwd, ".atelier", "sandbox.json"), '{ "allowWrite": ["~"] }');
		const result = await run(`echo ran > ${cwd}/ran.txt`);
		expect(result.ok).toBe(false);
		expect(result.output).toMatch(
			new RegExp(
				`^\\[sandbox error: Invalid sandbox configuration ${join(cwd, ".atelier", "sandbox.json")}: allowWrite entry "~" is refused: it would make ${home} writable, and that path stays protected\\]$`,
			),
		);
		expect(await exists(join(cwd, "ran.txt"))).toBe(false);
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

	it("cannot read the system keychains in /Library, but still runs node and a script of its own", async () => {
		const keychains = await run(
			"ls /Library/Keychains; cat /Library/Keychains/System.keychain | head -c 4; ls /Library/Keychains/System.keychain",
		);
		expect(keychains.ok).toBe(false);
		expect(keychains.output).not.toContain("System.keychain\n");
		expect(keychains.output.match(/Operation not permitted/g)).toHaveLength(3);

		const node = await run("node --version && cd candidate && node -e 'console.log(require(\"./dep.js\") + 1)'");
		expect(node.ok).toBe(true);
		expect(node.output).toMatch(/^v\d+\.\d+\.\d+\n42\n/);
	});

	it("ignores the configuration files: they add nothing to what the verifier writes or reads", async () => {
		await mkdir(join(home, "extra"));
		await mkdir(join(home, ".atelier"));
		await writeFile(
			join(home, ".atelier", "sandbox.json"),
			JSON.stringify({ allowWrite: ["~/extra", outside], denyRead: [verifierDir] }),
		);
		const result = await run(`echo x > ${home}/extra/file.txt; echo x > ${outside}/file.txt; cat candidate/dep.js`);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(2);
		expect(result.output).toContain("module.exports = 41;");
		expect(await exists(join(home, "extra", "file.txt"))).toBe(false);
		expect(await exists(join(outside, "file.txt"))).toBe(false);
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
