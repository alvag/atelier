import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBashTool } from "../src/tools/bash.ts";
import { isInsideSandbox, linkedWorktreeGit, Sandbox } from "../src/tools/sandbox.ts";

const onMac = process.platform === "darwin" && !isInsideSandbox();

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

	it("cannot read other tools' credential files, but reads the rest of their folders", async () => {
		const files = [
			".codex/auth.json",
			".local/share/opencode/auth.json",
			".netrc",
			".git-credentials",
			".config/git/credentials",
		];
		for (const file of files) {
			await mkdir(join(home, file, ".."), { recursive: true });
			await writeFile(join(home, file), "TOY-CLI-CREDENTIAL\n");
		}
		await writeFile(join(home, ".codex", "config.toml"), "model = 'toy'\n");
		const secret = await run(files.map((file) => `cat ${home}/${file}`).join("; "));
		expect(secret.ok).toBe(false);
		expect(secret.output).not.toContain("TOY-CLI-CREDENTIAL");
		expect(secret.output.match(/Operation not permitted/g)).toHaveLength(files.length);
		expect((await run(`cp ${home}/.codex/auth.json copy.txt`)).ok).toBe(false);
		expect(await exists(join(cwd, "copy.txt"))).toBe(false);
		expect((await run(`cat ${home}/.codex/config.toml`)).output).toContain("model = 'toy'");
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
					// Run from npx or pnpm, the test inherits npm_config_cache, which would point npm at the real cache.
					'unset npm_config_cache NPM_CONFIG_CACHE; cache="$(npm config get cache)" && echo "cache=$cache" && mkdir -p "$cache/_cacache" && echo ok > "$cache/_cacache/entry"',
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
 * Runs `command` until its result names the `expected` cause. The library reads
 * the denials from the system log, which can lag in the first seconds after it
 * starts or under load, so the same denied command is repeated for a while; the
 * cause itself is what is under test, not how fast the log answers. Another
 * cause can arrive first (a denied read before the denied connection), so
 * waiting for any cause is not enough.
 */
async function untilBlocked(
	tool: ReturnType<typeof createBashTool>,
	command: string,
	workDir: string,
	expected: string | RegExp,
) {
	const names = (output: string) => (typeof expected === "string" ? output.includes(expected) : expected.test(output));
	let result = await tool.execute({ command }, { cwd: workDir });
	for (let attempt = 0; attempt < 30 && !names(result.output); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		result = await tool.execute({ command }, { cwd: workDir });
	}
	return result;
}

describe.skipIf(!onMac)("what the sandbox says it blocked", () => {
	it("names the file a command tried to write", async () => {
		const result = await untilBlocked(
			createBashTool({ sandbox }),
			`echo x > ${outside}/file.txt`,
			cwd,
			`[sandbox blocked: write to ${outside}/file.txt`,
		);
		expect(result.ok).toBe(false);
		expect(result.output).toContain(`[sandbox blocked: write to ${outside}/file.txt (not an allowed write path)]`);
		expect(result.blocked).toContain(`write to ${outside}/file.txt (not an allowed write path)`);
	}, 30_000);

	it("names the secret a command tried to read", async () => {
		const result = await untilBlocked(
			createBashTool({ sandbox }),
			`cat ${home}/.ssh/id_rsa`,
			cwd,
			`[sandbox blocked: read of ${home}/.ssh/id_rsa`,
		);
		expect(result.output).toContain(`[sandbox blocked: read of ${home}/.ssh/id_rsa (denied by the sandbox policy)]`);
		expect(result.output).not.toContain("FAKE-PRIVATE-KEY");
	}, 30_000);

	it("names the connection the verifier tried to make", async () => {
		const server = await serve();
		try {
			const verifier = createBashTool({ withoutApproval: true, policy: "verifier", sandbox });
			const dir = join(base, "verify");
			await mkdir(dir, { recursive: true });
			const blocked = /\[sandbox blocked: network connect to [^ ]+ \(no network for the verifier\)\]/;
			const result = await untilBlocked(
				verifier,
				`curl -sS --max-time 3 http://127.0.0.1:${port(server.server)}/`,
				dir,
				blocked,
			);
			expect(result.output).toMatch(blocked);
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

	it("does not let a command create or replace the rules saved for projects", async () => {
		await mkdir(join(home, ".atelier"), { recursive: true });
		const result = await run(`echo '{}' > ${home}/.atelier/project-permissions.json`);
		expect(result.ok).toBe(false);
		expect(await exists(join(home, ".atelier", "project-permissions.json"))).toBe(false);
	});

	it("keeps another tool's credential file unwritable inside an added directory", async () => {
		await mkdir(join(home, ".codex"));
		await writeFile(join(home, ".codex", "auth.json"), "TOY-CLI-CREDENTIAL\n");
		await configure(join(home, ".atelier", "sandbox.json"), { allowWrite: ["~/.codex"] });
		const result = await run(
			`echo x > ${home}/.codex/auth.json; rm ${home}/.codex/auth.json; echo ok > ${home}/.codex/config.toml`,
		);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(2);
		expect(await readFile(join(home, ".codex", "auth.json"), "utf8")).toBe("TOY-CLI-CREDENTIAL\n");
		expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toBe("ok\n");
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

const OPERATION_STATE = ["rebase-merge", "rebase-apply", "sequencer"];

describe.skipIf(!onMac)("the agent's bash and the git operations that run steps later", () => {
	const git = (dir: string, ...args: string[]) =>
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, encoding: "utf8" });
	const run = (command: string) => createBashTool({ sandbox }).execute({ command }, { cwd });

	beforeEach(async () => {
		git(cwd, "init", "-q", "-b", "main");
		await writeFile(join(cwd, "a.txt"), "a\n");
		git(cwd, "add", "-A");
		git(cwd, "commit", "-qm", "base");
	});

	it.each(OPERATION_STATE)("cannot create %s in the project's .git", async (directory) => {
		const result = await run(`mkdir .git/${directory} && echo 'exec touch pwned' > .git/${directory}/todo`);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("Operation not permitted");
		expect(await exists(join(cwd, ".git", directory))).toBe(false);
	});

	it.each(OPERATION_STATE)("cannot write the pending steps already in %s", async (directory) => {
		const todo = join(cwd, ".git", directory, "git-rebase-todo");
		await mkdir(join(cwd, ".git", directory));
		await writeFile(todo, "pick abc123 first\n");
		const result = await run(
			`echo 'exec touch pwned' >> .git/${directory}/git-rebase-todo; echo x > .git/${directory}/new-file; rm .git/${directory}/git-rebase-todo`,
		);
		expect(result.ok).toBe(false);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(3);
		expect(await readFile(todo, "utf8")).toBe("pick abc123 first\n");
		expect(await exists(join(cwd, ".git", directory, "new-file"))).toBe(false);
	});

	it("cannot add an exec line to a rebase that stopped on a conflict", async () => {
		git(cwd, "switch", "-q", "-c", "topic");
		await writeFile(join(cwd, "a.txt"), "topic\n");
		git(cwd, "commit", "-qam", "topic");
		await writeFile(join(cwd, "b.txt"), "second\n");
		git(cwd, "add", "-A");
		git(cwd, "commit", "-qm", "second");
		git(cwd, "switch", "-q", "main");
		await writeFile(join(cwd, "a.txt"), "main\n");
		git(cwd, "commit", "-qam", "main");
		git(cwd, "switch", "-q", "topic");
		expect(() => git(cwd, "rebase", "main")).toThrow();
		const todo = join(cwd, ".git", "rebase-merge", "git-rebase-todo");
		const before = await readFile(todo, "utf8");
		const result = await run("echo 'exec touch pwned' >> .git/rebase-merge/git-rebase-todo");
		expect(result.ok).toBe(false);
		expect(result.output).toContain("Operation not permitted");
		expect(await readFile(todo, "utf8")).toBe(before);
	});

	it("cannot start a rebase, a cherry-pick of several commits or a revert of several", async () => {
		git(cwd, "switch", "-q", "-c", "topic");
		for (const file of ["b", "c"]) {
			await writeFile(join(cwd, `${file}.txt`), `${file}\n`);
			git(cwd, "add", "-A");
			git(cwd, "commit", "-qm", file);
		}
		git(cwd, "switch", "-q", "main");
		await writeFile(join(cwd, "d.txt"), "d\n");
		git(cwd, "add", "-A");
		git(cwd, "commit", "-qm", "d");
		const head = git(cwd, "rev-parse", "HEAD");
		// Some git versions (2.54) end a rebase that cannot create its state with exit code 0, so what is checked is the
		// denial and that nothing moved.
		for (const command of ["git rebase topic", "git cherry-pick topic~1..topic", "git revert HEAD~1..HEAD"]) {
			const result = await run(command);
			expect(result.output, command).toContain("Operation not permitted");
		}
		expect(git(cwd, "rev-parse", "HEAD")).toBe(head);
		for (const directory of OPERATION_STATE) expect(await exists(join(cwd, ".git", directory))).toBe(false);
	});

	it("still commits, branches, stashes, merges, tags and deletes packed refs", async () => {
		const result = await run(
			[
				"git switch -q -c topic",
				"echo b > b.txt && git add b.txt && git -c user.email=t@t -c user.name=t commit -qm b",
				"git switch -q main",
				"git merge -q --ff-only topic",
				"git switch -q -c other",
				"echo c > c.txt && git add c.txt && git -c user.email=t@t -c user.name=t commit -qm c",
				"git switch -q main",
				"echo d > d.txt && git add d.txt && git -c user.email=t@t -c user.name=t commit -qm d",
				"git -c user.email=t@t -c user.name=t merge -q --no-edit other",
				"echo e >> a.txt && git stash -q && git stash pop -q",
				"git tag v1 && git pack-refs --all && git tag -d v1 && git branch -D topic other",
			].join(" && "),
		);
		expect(result.ok, result.output).toBe(true);
		expect(git(cwd, "log", "--format=%s", "--no-merges").trim().split("\n")).toEqual(["d", "c", "b", "base"]);
	});

	it("still merges with a conflict, which leaves MERGE_HEAD", async () => {
		git(cwd, "switch", "-q", "-c", "topic");
		await writeFile(join(cwd, "a.txt"), "topic\n");
		git(cwd, "commit", "-qam", "topic");
		git(cwd, "switch", "-q", "main");
		await writeFile(join(cwd, "a.txt"), "main\n");
		git(cwd, "commit", "-qam", "main");
		const result = await run("git merge topic");
		expect(result.output).toContain("CONFLICT");
		expect(result.output).not.toContain("Operation not permitted");
		expect(await exists(join(cwd, ".git", "MERGE_HEAD"))).toBe(true);
	});
});

describe.skipIf(!onMac)("the agent's bash in a linked git worktree", () => {
	let main: string;
	let worktree: string;
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
	const run = (command: string) => createBashTool({ sandbox }).execute({ command }, { cwd: worktree });

	beforeEach(async () => {
		main = join(outside, "main");
		worktree = join(outside, "wt");
		await mkdir(main, { recursive: true });
		git(main, "init", "-q");
		await writeFile(join(main, "a.txt"), "a\n");
		git(main, "add", "-A");
		git(main, "commit", "-qm", "base");
		git(main, "worktree", "add", "-q", "--detach", worktree);
	});

	it("creates a branch and commits, writing the git data that lives in the main checkout", async () => {
		const result = await run(
			"git switch -q -c feature && echo b > b.txt && git add b.txt && git -c user.email=t@t -c user.name=t commit -qm b && git log --oneline | wc -l",
		);
		expect(result.output).not.toContain("Operation not permitted");
		expect(result.ok).toBe(true);
		expect(result.output).toMatch(/^\s*2$/m);
		expect(git(main, "branch", "--list", "feature")).toContain("feature");
	});

	it("cannot write what would make git run code or look elsewhere: config.worktree, commondir, gitdir, alternates", async () => {
		const common = join(main, ".git");
		const own = join(common, "worktrees", "wt");
		const result = await run(
			[
				`printf '[core]\\n\\thooksPath = ${common}/refs/x\\n' > ${own}/config.worktree`,
				`echo ${outside} > ${own}/commondir`,
				`echo ${outside}/x > ${own}/gitdir`,
				`mkdir -p ${common}/objects/info && echo ${outside} > ${common}/objects/info/alternates`,
			].join("; "),
		);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(4);
		expect(await exists(join(own, "config.worktree"))).toBe(false);
		expect(await readFile(join(own, "commondir"), "utf8")).not.toContain(outside);
	});

	it("keeps the secret file patterns inside the git data it may write", async () => {
		const common = join(main, ".git");
		const result = await run(`echo x > ${common}/objects/private.key; echo x > ${common}/refs/.env`);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(2);
	});

	it("grants nothing when the worktree's commondir points at another repository", async () => {
		const other = join(outside, "other");
		await mkdir(other, { recursive: true });
		git(other, "init", "-q");
		// Tampered before Atelier runs, by something outside the sandbox.
		await writeFile(join(main, ".git", "worktrees", "wt", "commondir"), `${join(other, ".git")}\n`);
		const result = await run(`echo x > ${join(other, ".git", "refs", "heads", "planted")}`);
		expect(result.output).toContain("Operation not permitted");
		expect(await exists(join(other, ".git", "refs", "heads", "planted"))).toBe(false);
	});

	it.each(OPERATION_STATE)("cannot create %s in the worktree's git directory", async (directory) => {
		const state = join(main, ".git", "worktrees", "wt", directory);
		const result = await run(`mkdir ${state} && echo 'exec touch pwned' > ${state}/todo`);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("Operation not permitted");
		expect(await exists(state)).toBe(false);
	});

	it.each(OPERATION_STATE)("cannot write the pending steps already in the worktree's %s", async (directory) => {
		const state = join(main, ".git", "worktrees", "wt", directory);
		await mkdir(state);
		await writeFile(join(state, "git-rebase-todo"), "pick abc123 first\n");
		const result = await run(
			`echo 'exec touch pwned' >> ${state}/git-rebase-todo; echo x > ${state}/new-file; rm ${state}/git-rebase-todo`,
		);
		expect(result.ok).toBe(false);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(3);
		expect(await readFile(join(state, "git-rebase-todo"), "utf8")).toBe("pick abc123 first\n");
		expect(await exists(join(state, "new-file"))).toBe(false);
	});

	it("cannot start a rebase, but still commits and merges", async () => {
		git(main, "switch", "-q", "-c", "topic");
		await writeFile(join(main, "t.txt"), "t\n");
		git(main, "add", "-A");
		git(main, "commit", "-qm", "t");
		git(main, "switch", "-q", "-");
		const head = git(worktree, "rev-parse", "HEAD");
		const rebase = await run("git rebase topic");
		// Some git versions (2.54) end a rebase that cannot create its state with exit code 0: nothing moved is what counts.
		expect(rebase.output).toContain("Operation not permitted");
		expect(git(worktree, "rev-parse", "HEAD")).toBe(head);
		const result = await run(
			"git switch -q -c feature && echo b > b.txt && git add b.txt && git -c user.email=t@t -c user.name=t commit -qm b && git -c user.email=t@t -c user.name=t merge -q --no-edit topic",
		);
		expect(result.ok, result.output).toBe(true);
	});

	it("packs and deletes refs", async () => {
		const result = await run("git branch tmp && git pack-refs --all && git branch -D tmp");
		expect(result.output).not.toContain("Operation not permitted");
		expect(result.ok).toBe(true);
	});

	// Independent verification (M11 L5): ordinary ref editing, configuration, pointers, hooks and secrets.
	it.each(["branch", "tag"])("deletes a packed %s", async (kind) => {
		git(main, kind, "packed-entry");
		git(main, "pack-refs", "--all");
		const result = await run(`git ${kind} ${kind === "branch" ? "-D" : "-d"} packed-entry`);
		expect(result.ok, result.output).toBe(true);
		expect(git(main, kind, "--list", "packed-entry")).toBe("");
	});

	it("cannot write worktree-specific configuration, even where the repository enables it", async () => {
		git(main, "config", "extensions.worktreeConfig", "true");
		const dir = git(worktree, "rev-parse", "--absolute-git-dir").trim();
		const result = await run("git config --worktree core.hooksPath /unused");
		expect(result.ok).toBe(false);
		expect(result.output).toContain("Operation not permitted");
		expect(await exists(join(dir, "config.worktree"))).toBe(false);
	});

	it.each(["refs", "objects"])("protects hooks the repository already configured under %s", async (dir) => {
		const hooks = join(main, ".git", dir, "custom-hooks");
		await mkdir(hooks, { recursive: true });
		const hook = join(hooks, "pre-commit");
		await writeFile(hook, "#!/bin/sh\nexit 0\n");
		git(main, "config", "core.hooksPath", hooks);
		const result = await run(`echo changed >> "${hook}"; echo x > "${hooks}/post-commit"`);
		expect(result.ok).toBe(false);
		expect(await readFile(hook, "utf8")).toBe("#!/bin/sh\nexit 0\n");
		expect(await exists(join(hooks, "post-commit"))).toBe(false);
	});

	for (const directory of ["objects", "refs", "logs", "worktrees/wt"])
		it.each([".env", ".env.local", "secret.pem", "secret.key"])(`protects ${directory}/%s`, async (file) => {
			const path = join(main, ".git", directory, file);
			const result = await run(`echo changed > "${path}"`);
			expect(result.ok).toBe(false);
			expect(await exists(path)).toBe(false);
		});

	it("detects only linked worktrees whose common directory is outside them, per working directory", async () => {
		const first = linkedWorktreeGit(worktree);
		expect(first?.commonDir).toBe(join(main, ".git"));
		expect(linkedWorktreeGit(main)).toBeUndefined();
		expect(linkedWorktreeGit(cwd)).toBeUndefined();
		const second = join(outside, "second");
		git(main, "worktree", "add", "-q", "--detach", second);
		expect(linkedWorktreeGit(second)?.gitDir).not.toBe(first?.gitDir);
		expect(linkedWorktreeGit(worktree)).toEqual(first);
	});

	it("protects a hooks directory configured relative to the checkout", async () => {
		const hooks = join(worktree, "custom-hooks");
		await mkdir(hooks);
		const hook = join(hooks, "pre-commit");
		await writeFile(hook, "#!/bin/sh\nexit 0\n");
		git(main, "config", "core.hooksPath", "custom-hooks");
		const result = await run(`echo changed >> "${hook}"`);
		expect(result.ok).toBe(false);
		expect(result.output).toContain("Operation not permitted");
		expect(await readFile(hook, "utf8")).toBe("#!/bin/sh\nexit 0\n");
	});

	it("does not grant the shared info directory", async () => {
		const attributes = join(main, ".git", "info", "attributes");
		await mkdir(join(main, ".git", "info"), { recursive: true });
		await writeFile(attributes, "a.txt custom=original\n");
		const result = await run(`echo changed > "${attributes}"`);
		expect(result.ok).toBe(false);
		expect(await readFile(attributes, "utf8")).toBe("a.txt custom=original\n");
	});

	it("still cannot write the shared git hooks or configuration, nor the main checkout's files", async () => {
		const common = join(main, ".git");
		const result = await run(
			`echo x > ${common}/hooks/pre-commit; echo x >> ${common}/config; echo x > ${common}/description; echo x > ${main}/a.txt`,
		);
		expect(result.output.match(/Operation not permitted/g)).toHaveLength(4);
		expect(await exists(join(common, "hooks", "pre-commit"))).toBe(false);
		expect(await readFile(join(main, "a.txt"), "utf8")).toBe("a\n");
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

	it("uses git, with the user's git configuration left out, and a temporary directory inside its own", async () => {
		const result = await run(
			'git --version && git init -q repo && cd repo && echo a > a && git add a && git -c user.name=t -c user.email=t@t commit -qm x && git log --oneline | wc -l && git config --global --list; node -e \'console.log(require("os").tmpdir())\' && mkdir -p "$TMPDIR/x" && echo tmp-ok',
		);
		expect(result.output).toMatch(/git version/);
		expect(result.output).toMatch(/^\s*1$/m);
		expect(result.output).toContain(`${verifierDir}/`);
		expect(result.output).toContain("tmp-ok");
		expect(result.output).not.toMatch(/user\.(name|email)=/);
	});

	it("runs /bin/sh, which reads the system's shell choice in /private/var/select, without an error", async () => {
		const result = await run("/bin/sh -c 'echo sh-ok'");
		expect(result.ok).toBe(true);
		expect(result.output).toContain("sh-ok");
		expect(result.output).not.toContain("Error opening");
	});

	it("has a home of its own, so git works even with the GIT_* variables removed, as Atelier's own git calls do", async () => {
		const result = await run(
			'git init -q repo && env -u GIT_CONFIG_GLOBAL -u GIT_CONFIG_NOSYSTEM git -C repo rev-parse --is-inside-work-tree && echo "home=$HOME"',
		);
		expect(result.ok).toBe(true);
		expect(result.output).toContain("true");
		expect(result.output).toContain(`home=${verifierDir}/`);
	});

	it.each([
		["ls", "cat"],
		["cat", "ls"],
	])("compares copies through the /var link and denies outside reads, %s then %s", async (first, second) => {
		const linked = await mkdtemp(join(tmpdir(), "atelier-verify-"));
		try {
			for (const copy of ["base", "candidate"]) {
				await mkdir(join(linked, copy));
				await writeFile(join(linked, copy, "a.txt"), `${copy}\n`);
			}
			// The system's PATH only: a folder of the user's PATH the verifier cannot read would be reported as a block.
			const system = createBashTool({
				withoutApproval: true,
				policy: "verifier",
				sandbox,
				env: { PATH: "/usr/bin:/bin" },
			});
			const result = await system.execute(
				{ command: "cd candidate && cat ../base/a.txt && ls .. && diff -u ../base/a.txt a.txt" },
				{ cwd: linked },
			);
			// diff exits with 1 when the files differ, so the sandbox's denials for the run are reported.
			expect(result.ok).toBe(false);
			expect(result.output).not.toContain("Operation not permitted");
			expect(result.output).not.toContain("sandbox blocked");
			expect(result.output).toContain("+candidate");
			expect(result.output).toContain("base\nbase\ncandidate\n");

			// Keep the TMPDIR sibling and link-spelled cwd: only genuine /private/var paths have a /var alias.
			const secret = join(outside, "secret.txt").replace(/^\/private\/var\//, "/var/");
			expect(await realpath(secret)).toBe(join(outside, "secret.txt"));
			expect(await readFile(secret, "utf8")).toBe("OUTSIDE-SECRET\n");
			const commands = [first, second].map((operation) => (operation === "ls" ? "ls /var/" : `cat ${secret}`));
			const beyond = await verifier().execute({ command: `readlink /var; ${commands.join("; ")}` }, { cwd: linked });
			const diagnostic = `cwd=${linked}\n${beyond.output}`;
			expect(beyond.ok, diagnostic).toBe(false);
			expect(beyond.output, diagnostic).toMatch(/^private\/var$/m);
			expect(beyond.output, diagnostic).not.toContain("OUTSIDE-SECRET");
			expect(beyond.output.match(/Operation not permitted/g), diagnostic).toHaveLength(2);
			for (const command of commands) {
				const denied = await verifier().execute({ command }, { cwd: linked });
				const detail = `cwd=${linked}\n${command}\n${denied.output}`;
				expect(denied.ok, detail).toBe(false);
				expect(denied.output, detail).not.toContain("OUTSIDE-SECRET");
				expect(denied.output.match(/Operation not permitted/g), detail).toHaveLength(1);
			}
		} finally {
			await rm(linked, { recursive: true, force: true });
		}
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

describe.skipIf(!onMac)("the commands the user's rules cover", () => {
	const run = (command: string) => createBashTool({ sandbox }).execute({ command }, { cwd, bashRules: ["touch"] });

	it("run outside the sandbox, where the home is writable", async () => {
		const result = await run(`touch ${home}/covered.txt`);
		expect(result.ok).toBe(true);
		expect(await exists(join(home, "covered.txt"))).toBe(true);
	});

	it("write other tools' credential files, as their own sign-in and token refresh do", async () => {
		await mkdir(join(home, ".codex"));
		expect((await run(`touch ${home}/.codex/auth.json ${home}/.netrc`)).ok).toBe(true);
		expect(await exists(join(home, ".codex", "auth.json"))).toBe(true);
		expect(await exists(join(home, ".netrc"))).toBe(true);
	});

	it("never write ~/.atelier, by a name the rules do not see or through a link", async () => {
		await mkdir(join(home, ".atelier"));
		await symlink(join(home, ".atelier"), join(outside, "link"));
		const quoted = await run(`touch ${home}/.ate""lier/permissions.json`);
		expect(quoted.ok).toBe(false);
		const linked = await run(`touch ${outside}/link/permissions.json`);
		expect(linked.ok).toBe(false);
		expect(await exists(join(home, ".atelier", "permissions.json"))).toBe(false);
	});

	it("never write the rules saved for projects, by a global rule or through a link a project rule does not follow", async () => {
		await mkdir(join(home, ".atelier"), { recursive: true });
		await symlink(join(home, ".atelier"), join(cwd, "settings"));
		const tool = createBashTool({ sandbox });
		const quoted = await tool.execute(
			{ command: `touch ${home}/.ate""lier/project-permi""ssions.json` },
			{ cwd, bashRules: ["touch"] },
		);
		expect(quoted.output).toContain("[ran outside the sandbox");
		expect(quoted.ok).toBe(false);
		// A link out of the project is never covered by a project rule: the command runs in the sandbox, which denies it.
		const linked = await tool.execute(
			{ command: `touch settings/project-permi""ssions.json` },
			{ cwd, projectBashRules: ["touch"], projectBounds: await realpath(cwd) },
		);
		expect(linked.output).not.toContain("[ran outside the sandbox");
		expect(linked.ok).toBe(false);
		expect(await exists(join(home, ".atelier", "project-permissions.json"))).toBe(false);
	});

	it("never write the rules saved for projects from a script a project rule covers", async () => {
		await mkdir(join(home, ".atelier"), { recursive: true });
		await writeFile(join(cwd, "w.sh"), `#!/bin/sh\ntouch '${home}/.atelier/project-permissions.json'\n`, {
			mode: 0o755,
		});
		const covered = await createBashTool({ sandbox }).execute(
			{ command: "./w.sh" },
			{ cwd, projectBashRules: ["./w.sh"], projectBounds: await realpath(cwd) },
		);
		expect(covered.output).toContain("[ran outside the sandbox");
		expect(covered.ok).toBe(false);
		expect(await exists(join(home, ".atelier", "project-permissions.json"))).toBe(false);
	});

	it("keep the main sandbox's protected writes: git hooks and config, shell start-up files, secrets", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		execFileSync("git", ["config", "core.hooksPath", "my-hooks"], { cwd });
		await mkdir(join(cwd, "my-hooks"));
		// Every folder exists, so a write fails only because the profile denies it.
		for (const dir of ["sub", ".vscode", ".git/rebase-merge"]) await mkdir(join(cwd, dir), { recursive: true });
		for (const path of [
			".git/hooks/pre-commit",
			".git/config",
			"my-hooks/pre-commit",
			".git/rebase-merge/git-rebase-todo",
			".zshrc",
			".vscode/settings.json",
			".env",
			".env.local",
			"sub/server.pem",
			"sub/id.key",
		]) {
			const result = await run(`touch ${join(cwd, path)}`);
			expect(result.ok, path).toBe(false);
		}
		expect(await exists(join(cwd, ".git", "hooks", "pre-commit"))).toBe(false);
		expect(await exists(join(cwd, "my-hooks", "pre-commit"))).toBe(false);
		expect(await exists(join(cwd, ".env"))).toBe(false);
		expect((await run(`touch ${join(cwd, "notes.txt")}`)).ok).toBe(true);
	});

	it("cannot move a protected place or a folder above it to write it under another name", async () => {
		execFileSync("git", ["init", "-q"], { cwd });
		const bypass = `mv ${join(cwd, ".git")} ${join(cwd, "g")} && echo x > ${join(cwd, "g", "hooks", "pre-commit")}; mv ${join(cwd, "g")} ${join(cwd, ".git")}`;
		expect((await run(bypass)).ok).toBe(false);
		expect(await exists(join(cwd, ".git", "hooks", "pre-commit"))).toBe(false);
		expect(await exists(join(cwd, "g"))).toBe(false);
		expect((await run(`mv ${cwd} ${join(base, "moved")}`)).ok).toBe(false);
		expect(await exists(join(cwd, ".git"))).toBe(true);
		// Ordinary files are still created, moved and removed.
		const file = join(cwd, "a.txt");
		expect((await run(`touch ${file} && mv ${file} ${join(cwd, "b.txt")} && rm ${join(cwd, "b.txt")}`)).ok).toBe(true);
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
