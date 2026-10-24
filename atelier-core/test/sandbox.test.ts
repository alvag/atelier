import { describe, expect, it } from "vitest";
import {
	agentPolicy,
	NOT_AVAILABLE_ON_PLATFORM,
	Sandbox,
	type SandboxManagerLike,
	verifierPolicy,
} from "../src/tools/sandbox.ts";

const SESSION = { cwd: "/work/project", scratchDir: "/tmp/atelier-session-1", tempDir: "/tmp/sys", home: "/home/ana" };

interface Calls {
	initialize: unknown[];
	wrap: { command: string; binShell: string | undefined; custom: unknown; signal: AbortSignal | undefined }[];
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
		async wrapWithSandbox(command, binShell, custom, signal) {
			calls.wrap.push({ command, binShell, custom, signal });
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
	it("writes to the working directory, the system temporary directory and the session scratch directory", () => {
		const policy = agentPolicy(SESSION);
		expect(policy.filesystem.allowWrite).toEqual(["/work/project", "/tmp/sys", "/tmp/atelier-session-1"]);
	});

	it("leaves the scratch directory out when the session has none", () => {
		const { scratchDir: _, ...withoutScratch } = SESSION;
		expect(agentPolicy(withoutScratch).filesystem.allowWrite).toEqual(["/work/project", "/tmp/sys"]);
	});

	it("denies writing .env, .env.*, *.pem and *.key anywhere in the working directory", () => {
		expect(agentPolicy(SESSION).filesystem.denyWrite).toEqual([
			"/work/project/.env",
			"/work/project/.env.*",
			"/work/project/**/.env",
			"/work/project/**/.env.*",
			"/work/project/**/*.pem",
			"/work/project/**/*.key",
		]);
	});

	it("denies reading the user's credential directories and keychains", () => {
		expect(agentPolicy(SESSION).filesystem.denyRead).toEqual([
			"/home/ana/.ssh",
			"/home/ana/.aws",
			"/home/ana/.gnupg",
			"/home/ana/.config/gh",
			"/home/ana/Library/Keychains",
			"/home/ana/.claude",
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
			"/Library",
			"/etc",
			"/private/etc",
			"/dev",
			"/opt/homebrew",
		]);
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
		expect(await sandbox.status()).toEqual({ available: false, reason: "sandbox-exec not found" });
		expect(calls.initialize).toEqual([]);
	});

	it("is unavailable, with the library's words, when initialization fails; it is not retried", async () => {
		const { manager, calls } = fakeManager({
			async initialize() {
				throw new Error("proxy could not start");
			},
		});
		const sandbox = new Sandbox({ platform: "darwin", manager });
		expect(await sandbox.status()).toEqual({ available: false, reason: "proxy could not start" });
		expect(await sandbox.status()).toEqual({ available: false, reason: "proxy could not start" });
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

	it("wraps with the verifier policy built from the working directory", async () => {
		const { manager, calls } = fakeManager();
		const sandbox = new Sandbox({ platform: "darwin", manager, home: "/home/ana", nodePrefix: "/node" });
		await sandbox.wrap("ls", { policy: "verifier", cwd: "/tmp/atelier-verify-9" });
		expect(calls.wrap[0]?.custom).toEqual(verifierPolicy({ dir: "/tmp/atelier-verify-9", nodePrefix: "/node" }));
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
