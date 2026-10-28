import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	agentPolicy,
	INSIDE_SANDBOX,
	NOT_AVAILABLE_ON_PLATFORM,
	Sandbox,
	type SandboxManagerLike,
	verifierPolicy,
} from "../src/tools/sandbox.ts";

const SESSION = { cwd: "/work/project", scratchDir: "/tmp/atelier-session-1", tempDir: "/tmp/sys", home: "/home/ana" };

interface Calls {
	initialize: unknown[];
	wrap: {
		command: string;
		binShell: string | undefined;
		custom: unknown;
		signal: AbortSignal | undefined;
		options?: unknown;
	}[];
	cleanup: number;
	reset: number;
}

function fakeManager(overrides: Partial<SandboxManagerLike> = {}): { manager: SandboxManagerLike; calls: Calls } {
	const calls: Calls = { initialize: [], wrap: [], cleanup: 0, reset: 0 };
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		async initialize(config) {
			calls.initialize.push(config);
		},
		async wrapWithSandbox(command, binShell, custom, signal, options) {
			calls.wrap.push({ command, binShell, custom, signal, ...(options === undefined ? {} : { options }) });
			return `wrapped(${command})`;
		},
		cleanupAfterCommand() {
			calls.cleanup++;
		},
		async reset() {
			calls.reset++;
		},
		...overrides,
	};
	return { manager, calls };
}

describe("agentPolicy", () => {
	const CACHES = [
		"/home/ana/.npm",
		"/home/ana/Library/pnpm",
		"/home/ana/.local/share/pnpm",
		"/home/ana/.pnpm-store",
		"/home/ana/.yarn",
		"/home/ana/.node-gyp",
		"/home/ana/.cache",
		"/home/ana/Library/Caches",
	];

	/** What the library protects in the directory it is started in, not in the session's. */
	const LIBRARY_PROTECTED = [
		".git/hooks",
		".git/config",
		".gitconfig",
		".gitmodules",
		".bashrc",
		".bash_profile",
		".zshrc",
		".zprofile",
		".profile",
		".ripgreprc",
		".mcp.json",
		".vscode",
		".idea",
		".claude/commands",
		".claude/agents",
	];

	it("writes to the working directory, the system temporary directory, the session scratch directory and the package caches", () => {
		const policy = agentPolicy(SESSION);
		expect(policy.filesystem.allowWrite).toEqual(["/work/project", "/tmp/sys", "/tmp/atelier-session-1", ...CACHES]);
	});

	it("leaves the scratch directory out when the session has none", () => {
		const { scratchDir: _, ...withoutScratch } = SESSION;
		expect(agentPolicy(withoutScratch).filesystem.allowWrite).toEqual(["/work/project", "/tmp/sys", ...CACHES]);
	});

	it("never makes the home directory writable, nor a secret path", () => {
		const { allowWrite = [], denyRead = [] } = agentPolicy(SESSION).filesystem;
		expect(allowWrite).not.toContain("/home/ana");
		for (const secret of denyRead)
			expect(allowWrite.filter((path) => secret === path || String(secret).startsWith(`${path}/`))).toEqual([]);
	});

	it("adds the configuration's write paths and read denials, keeping every fixed protection", () => {
		const policy = agentPolicy({
			...SESSION,
			additions: { allowWrite: ["/data/shared"], denyRead: ["/home/ana/Documents"] },
		});
		expect(policy.filesystem.allowWrite).toEqual([
			"/work/project",
			"/tmp/sys",
			"/tmp/atelier-session-1",
			...CACHES,
			"/data/shared",
		]);
		expect(policy.filesystem.denyRead).toEqual([
			"/home/ana/.ssh",
			"/home/ana/.aws",
			"/home/ana/.gnupg",
			"/home/ana/.config/gh",
			"/home/ana/Library/Keychains",
			"/home/ana/.claude",
			"/home/ana/.atelier/auth.json",
			"/home/ana/.atelier/mcp-auth.json",
			"/home/ana/.atelier/.credentials-tmp",
			"/home/ana/.codex/auth.json",
			"/home/ana/.local/share/opencode/auth.json",
			"/home/ana/.netrc",
			"/home/ana/.git-credentials",
			"/home/ana/.config/git/credentials",
			"/home/ana/Documents",
		]);
		expect(policy.filesystem.denyWrite).toEqual(
			expect.arrayContaining([
				"/work/project/.env",
				"/data/shared/.env",
				"/data/shared/**/*.pem",
				"/data/shared/**/*.key",
			]),
		);
	});

	it("in a linked worktree, writes its git data in the main checkout but not the shared hooks or configuration", () => {
		const worktreeGit = { gitDir: "/work/main/.git/worktrees/project", commonDir: "/work/main/.git" };
		const { filesystem } = agentPolicy({ ...SESSION, worktreeGit });
		for (const path of [
			"/work/main/.git/worktrees/project",
			"/work/main/.git/objects",
			"/work/main/.git/refs",
			"/work/main/.git/logs",
			"/work/main/.git/packed-refs",
			"/work/main/.git/packed-refs.lock",
		])
			expect(filesystem.allowWrite).toContain(path);
		expect(filesystem.allowWrite).not.toContain("/work/main/.git");
		expect(filesystem.allowWrite).not.toContain("/work/main");
		expect(filesystem.allowWrite).toContain("/work/main/.git/packed-refs.new");
		expect(filesystem.denyWrite).toEqual(
			expect.arrayContaining([
				"/work/main/.git/hooks",
				"/work/main/.git/config",
				"/work/main/.git/config.worktree",
				"/work/main/.git/objects/info",
				"/work/main/.git/worktrees/project/config.worktree",
				"/work/main/.git/worktrees/project/commondir",
				"/work/main/.git/worktrees/project/gitdir",
				"/work/main/.git/objects/**/*.key",
			]),
		);
		const outsideCheckout = agentPolicy(SESSION).filesystem.allowWrite.map((entry) =>
			typeof entry === "string" ? entry : entry.path,
		);
		expect(outsideCheckout.some((path) => path.startsWith("/work/main"))).toBe(false);
	});

	it("never writes the pending steps of a rebase, a cherry-pick or a revert, in the project's .git or a linked worktree's", () => {
		const own = "/work/main/.git/worktrees/project";
		const steps = (dir: string) => ["rebase-merge", "rebase-apply", "sequencer"].map((name) => `${dir}/${name}`);
		expect(agentPolicy(SESSION).filesystem.denyWrite).toEqual(expect.arrayContaining(steps("/work/project/.git")));
		const worktreeGit = { gitDir: own, commonDir: "/work/main/.git" };
		const { denyWrite } = agentPolicy({ ...SESSION, worktreeGit }).filesystem;
		expect(denyWrite).toEqual(expect.arrayContaining(steps(own)));
		const added = agentPolicy({ ...SESSION, additions: { allowWrite: ["/data/shared"], denyRead: [] } }).filesystem
			.denyWrite;
		expect(added).toEqual(expect.arrayContaining(steps("/data/shared/.git")));
	});

	it("does not let a command write the project's .atelier directory, where its configuration lives", () => {
		expect(agentPolicy(SESSION).filesystem.denyWrite).toContain("/work/project/.atelier");
	});

	it("denies writing .env, .env.*, *.pem and *.key anywhere in the working directory", () => {
		expect(agentPolicy(SESSION).filesystem.denyWrite).toEqual([
			"/work/project/.env",
			"/work/project/.env.*",
			"/work/project/**/.env",
			"/work/project/**/.env.*",
			"/work/project/**/*.pem",
			"/work/project/**/*.key",
			...LIBRARY_PROTECTED.map((path) => `/work/project/${path}`),
			"/work/project/.git/rebase-merge",
			"/work/project/.git/rebase-apply",
			"/work/project/.git/sequencer",
			"/work/project/.atelier",
		]);
	});

	it("denies reading the user's credential directories, keychains, Atelier's credential files and other tools' ones", () => {
		expect(agentPolicy(SESSION).filesystem.denyRead).toEqual([
			"/home/ana/.ssh",
			"/home/ana/.aws",
			"/home/ana/.gnupg",
			"/home/ana/.config/gh",
			"/home/ana/Library/Keychains",
			"/home/ana/.claude",
			"/home/ana/.atelier/auth.json",
			"/home/ana/.atelier/mcp-auth.json",
			"/home/ana/.atelier/.credentials-tmp",
			"/home/ana/.codex/auth.json",
			"/home/ana/.local/share/opencode/auth.json",
			"/home/ana/.netrc",
			"/home/ana/.git-credentials",
			"/home/ana/.config/git/credentials",
		]);
	});

	it("does not configure the network, which leaves it unrestricted", () => {
		expect(agentPolicy(SESSION)).not.toHaveProperty("network");
	});
});

describe("verifierPolicy", () => {
	const verifier = { dir: "/tmp/atelier-verify-1", nodePrefix: "/home/ana/.nvm/versions/node/v26.0.0" };

	it("writes only to the verifier's temporary directory", () => {
		const { filesystem } = verifierPolicy(verifier);
		expect(filesystem.allowWrite).toEqual(["/tmp/atelier-verify-1"]);
		expect(filesystem.denyWrite).toEqual([]);
	});

	it("has no network: an empty allow list sends every connection to a proxy that refuses it", () => {
		expect(verifierPolicy(verifier).network).toEqual({ allowedDomains: [], deniedDomains: ["*"] });
	});

	it("denies reading everything except its directory, the Node installation and the system toolchain", () => {
		const { filesystem } = verifierPolicy(verifier);
		expect(filesystem.denyRead).toEqual(["/"]);
		expect(filesystem.allowRead).toEqual([
			"/tmp/atelier-verify-1",
			"/home/ana/.nvm/versions/node/v26.0.0",
			"/usr",
			"/bin",
			"/sbin",
			"/System",
			"/Library/Apple/usr",
			"/Library/Frameworks",
			"/etc",
			"/private/etc",
			"/dev",
			"/opt/homebrew",
			"/private/var/select",
			"/var",
			"/private/var/db/timezone",
			"/tmp/package.json",
			"/package.json",
		]);
	});

	it("reads the package.json of every folder above its directory, and nothing else of those folders", () => {
		const reads = verifierPolicy({ ...verifier, dir: "/var/folders/x/T/atelier-verify-2" }).filesystem.allowRead ?? [];
		expect(reads.filter((path) => typeof path === "string" && path.endsWith("package.json"))).toEqual([
			"/var/folders/x/T/package.json",
			"/var/folders/x/package.json",
			"/var/folders/package.json",
			"/var/package.json",
			"/package.json",
		]);
		expect(reads).not.toContain("/var/folders/x/T");
		expect(reads).not.toContain("/var/folders");
		expect(reads).not.toContain("/private/var/folders");
	});

	it("adds the developer directory's usr/ when there is a real git to run", () => {
		const { filesystem } = verifierPolicy({ ...verifier, toolchain: "/Applications/Xcode.app/Contents/Developer/usr" });
		expect(filesystem.allowRead).toContain("/Applications/Xcode.app/Contents/Developer/usr");
		expect(filesystem.allowRead).not.toContain("/Applications");
	});

	it("does not read /Library as a whole: its Keychains and the rest stay out", () => {
		const reads = (verifierPolicy(verifier).filesystem.allowRead ?? []).map((entry) =>
			typeof entry === "string" ? entry : entry.path,
		);
		expect(reads).not.toContain("/Library");
		expect(reads.filter((path) => path.startsWith("/Library"))).toEqual(["/Library/Apple/usr", "/Library/Frameworks"]);
	});

	it("never lists the home directory or anything of the user's under it, apart from the Node installation", () => {
		const reads = (verifierPolicy(verifier).filesystem.allowRead ?? []).map((entry) =>
			typeof entry === "string" ? entry : entry.path,
		);
		expect(reads.filter((path) => path.startsWith("/home/ana"))).toEqual(["/home/ana/.nvm/versions/node/v26.0.0"]);
	});
});

describe("Sandbox status", () => {
	it("is unavailable outside macOS, without touching the library", async () => {
		const { manager, calls } = fakeManager();
		const sandbox = new Sandbox({ platform: "linux", manager });
		expect(await sandbox.status()).toEqual({ available: false, reason: "sandbox not available on this platform" });
		expect(NOT_AVAILABLE_ON_PLATFORM).toBe("sandbox not available on this platform");
		expect(calls.initialize).toEqual([]);
		await expect(sandbox.wrap("ls", { policy: "agent", ...SESSION })).rejects.toThrow(/sandbox not available/);
		expect(calls.wrap).toEqual([]);
	});

	it("is unavailable inside another sandbox, which macOS cannot nest, without touching the library", async () => {
		const { manager, calls } = fakeManager();
		const sandbox = new Sandbox({ platform: "darwin", manager, insideSandbox: () => true });
		expect(await sandbox.status()).toEqual({ available: false, reason: INSIDE_SANDBOX });
		expect(INSIDE_SANDBOX).toBe(
			"already inside a sandbox, and macOS cannot nest them: commands stay confined by the outer one",
		);
		expect(calls.initialize).toEqual([]);
	});

	it("is unavailable when the library does not support the platform", async () => {
		const { manager, calls } = fakeManager({ isSupportedPlatform: () => false });
		const sandbox = new Sandbox({ platform: "darwin", manager });
		expect(await sandbox.status()).toEqual({ available: false, reason: "sandbox not available on this platform" });
		expect(calls.initialize).toEqual([]);
	});

	it("is unavailable, with the library's words, when a dependency is missing", async () => {
		const { manager, calls } = fakeManager({
			checkDependencies: () => ({ errors: ["sandbox-exec not found"], warnings: [] }),
		});
		const sandbox = new Sandbox({ platform: "darwin", manager });
		expect(await sandbox.status()).toEqual({ available: false, reason: "sandbox-exec not found", failed: true });
		expect(calls.initialize).toEqual([]);
	});

	it("is unavailable, with the library's words, when initialization fails; it is not retried", async () => {
		const { manager, calls } = fakeManager({
			async initialize() {
				throw new Error("proxy could not start");
			},
		});
		const sandbox = new Sandbox({ platform: "darwin", manager });
		expect(await sandbox.status()).toEqual({ available: false, reason: "proxy could not start", failed: true });
		expect(await sandbox.status()).toEqual({ available: false, reason: "proxy could not start", failed: true });
		expect(calls.wrap).toEqual([]);
	});

	it("initializes once, lazily, with a network that is not restricted", async () => {
		const { manager, calls } = fakeManager();
		const sandbox = new Sandbox({ platform: "darwin", manager });
		expect(calls.initialize).toEqual([]);
		const [first, second] = await Promise.all([sandbox.status(), sandbox.status()]);
		expect(first).toEqual({ available: true });
		expect(second).toEqual({ available: true });
		expect(calls.initialize).toHaveLength(1);
		const config = calls.initialize[0] as { network: Record<string, unknown> };
		expect(config.network).not.toHaveProperty("allowedDomains");
		expect(config.network.deniedDomains).toEqual(["*"]);
	});
});

describe("Sandbox wrap", () => {
	it("wraps with the agent policy built from the session, passing bash and the abort signal", async () => {
		const { manager, calls } = fakeManager();
		const sandbox = new Sandbox({ platform: "darwin", manager, home: SESSION.home, tempDir: SESSION.tempDir });
		const signal = new AbortController().signal;
		const wrapped = await sandbox.wrap("npm test", {
			policy: "agent",
			cwd: SESSION.cwd,
			scratchDir: SESSION.scratchDir,
			signal,
		});
		expect(wrapped).toBe("wrapped(npm test)");
		expect(calls.wrap).toEqual([{ command: "npm test", binShell: "bash", custom: agentPolicy(SESSION), signal }]);
	});

	it("gives the library the run's id to record its denials under, with the command as their text", async () => {
		const { manager, calls } = fakeManager();
		const sandbox = new Sandbox({ platform: "darwin", manager, home: SESSION.home, tempDir: SESSION.tempDir });
		await sandbox.wrap("npm test", { policy: "agent", cwd: SESSION.cwd, runId: "run-1" });
		expect(calls.wrap[0]?.options).toEqual({ commandId: "run-1", commandText: "npm test" });
	});

	it("wraps with the verifier policy built from the working directory", async () => {
		const { manager, calls } = fakeManager();
		const sandbox = new Sandbox({ platform: "darwin", manager, home: "/home/ana", nodePrefix: "/node" });
		await sandbox.wrap("ls", { policy: "verifier", cwd: "/tmp/atelier-verify-9" });
		expect(calls.wrap[0]?.custom).toEqual(verifierPolicy({ dir: "/tmp/atelier-verify-9", nodePrefix: "/node" }));
	});

	it("adds what the configuration files say to the agent's policy only", async () => {
		const home = await mkdtemp(join(tmpdir(), "atelier-wrap-"));
		try {
			await mkdir(join(home, ".atelier"));
			await writeFile(
				join(home, ".atelier", "sandbox.json"),
				JSON.stringify({ allowWrite: ["~/extra"], denyRead: ["~/private"] }),
			);
			const { manager, calls } = fakeManager();
			const sandbox = new Sandbox({ platform: "darwin", manager, home, tempDir: "/tmp/sys", nodePrefix: "/node" });
			await sandbox.wrap("ls", { policy: "agent", cwd: "/work/project" });
			await sandbox.wrap("ls", { policy: "verifier", cwd: "/tmp/atelier-verify-9" });
			const agent = calls.wrap[0]?.custom as ReturnType<typeof agentPolicy>;
			expect(agent.filesystem.allowWrite).toContain(join(realpathSync(home), "extra"));
			expect(agent.filesystem.denyRead).toContain(join(realpathSync(home), "private"));
			expect(calls.wrap[1]?.custom).toEqual(verifierPolicy({ dir: "/tmp/atelier-verify-9", nodePrefix: "/node" }));
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("refuses to wrap a command when a configuration file is invalid", async () => {
		const home = await mkdtemp(join(tmpdir(), "atelier-wrap-"));
		try {
			await mkdir(join(home, ".atelier"));
			await writeFile(join(home, ".atelier", "sandbox.json"), "{ nope");
			const { manager, calls } = fakeManager();
			const sandbox = new Sandbox({ platform: "darwin", manager, home });
			await expect(sandbox.wrap("ls", { policy: "agent", cwd: "/work/project" })).rejects.toThrow(
				/^Invalid sandbox configuration .*sandbox\.json: not valid JSON/,
			);
			expect(calls.wrap).toEqual([]);
			// The verifier does not read the file at all.
			// The verifier's command gets its own temporary directory first; the configuration files never apply to it.
			await expect(sandbox.wrap("ls", { policy: "verifier", cwd: "/tmp/v" })).resolves.toBe(
				"wrapped(export TMPDIR='/tmp/v/.tmp'\nls)",
			);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("cleans up after a command and resets the library on close", async () => {
		const { manager, calls } = fakeManager();
		const sandbox = new Sandbox({ platform: "darwin", manager });
		await sandbox.wrap("ls", { policy: "agent", cwd: "/work" });
		sandbox.cleanup();
		expect(calls.cleanup).toBe(1);
		await sandbox.reset();
		expect(calls.reset).toBe(1);
		// A later command initializes again.
		await sandbox.wrap("ls", { policy: "agent", cwd: "/work" });
		expect(calls.initialize).toHaveLength(2);
	});

	it("does not reset a library it never initialized", async () => {
		const { manager, calls } = fakeManager();
		await new Sandbox({ platform: "linux", manager }).reset();
		expect(calls.reset).toBe(0);
	});
});
