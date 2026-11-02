import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../src/auth-store.ts";
import {
	bundledClaudeCode,
	ClaudeCodeAuthError,
	claudeCodeAuthStatus,
	claudeCodeLogin,
	claudeCodeLogout,
	describeClaudeCodeAuth,
	loginWarning,
	signedInBackends,
} from "../src/claude-code-auth.ts";
import { MISSING_API_KEY_MESSAGE, MISSING_OPENCODE_GO_KEY_MESSAGE } from "../src/credentials.ts";
import { isInsideSandbox } from "../src/tools/sandbox.ts";
import { requireIsolatedHome } from "./support/login-isolation.ts";

requireIsolatedHome();

let dir: string;
let fake: string;

/**
 * A stand-in for the Claude Code binary: it logs its arguments and whether it got ANTHROPIC_API_KEY, and its process
 * group in `$dir/pgid`, prints `$dir/status.json` for `auth status --json` (exit 1 when not logged in, as Claude Code
 * does), and `auth login` writes `$dir/after-login.json` over it.
 */
async function writeFake(): Promise<void> {
	fake = join(dir, "claude");
	await writeFile(
		fake,
		`#!/bin/sh
echo "$* key=\${ANTHROPIC_API_KEY:-none}" >> "${dir}/calls.log"
/bin/ps -o pgid= -p $$ > "${dir}/pgid" 2>/dev/null
case "$1 $2" in
"auth status") cat "${dir}/status.json"; grep -q '"loggedIn": *true' "${dir}/status.json" ;;
"auth login") cp "${dir}/after-login.json" "${dir}/status.json"; exit "\${FAKE_EXIT:-0}" ;;
"auth logout") echo '{"loggedIn":false,"authMethod":"none"}' > "${dir}/status.json" ;;
esac
`,
	);
	await chmod(fake, 0o755);
}

const status = (value: object) => writeFile(join(dir, "status.json"), JSON.stringify(value));
const calls = async () => (await readFile(join(dir, "calls.log"), "utf8")).trim().split("\n");
/** The process group the fake ran in last, and the tests' own. */
const fakeGroup = async () => Number((await readFile(join(dir, "pgid"), "utf8")).trim());
const ownGroup = () =>
	Number(spawnSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).stdout.trim());
/** Process groups are read with `ps`, which a sandbox around the tests refuses. */
const canListProcesses = process.platform !== "darwin" || !isInsideSandbox();

const until = async (condition: () => boolean) => {
	for (let i = 0; i < 600 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
	expect(condition()).toBe(true);
};

/** Whether a process runs, a zombie not counted: one killed is a zombie until its parent, or launchd, reaps it. */
function running(pid: number): boolean {
	const stat = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
	return stat !== "" && !stat.startsWith("Z");
}

/**
 * A binary that answers badly, as FAKE says: `big` prints more than execFile keeps (1 MiB), `split` prints a status
 * whose `ñ` comes in two writes, `stuck` ignores TERM and never answers; FAKE_STAY keeps it running, TERM ignored,
 * after what it printed. It writes its pid to `$dir/odd.pid`.
 */
async function writeOdd(): Promise<string> {
	const odd = join(dir, "odd");
	await writeFile(
		odd,
		`#!/bin/sh
echo $$ > "${dir}/odd.pid"
stay() { trap '' TERM; while :; do sleep 0.1; done; }
case "$FAKE" in
big) head -c 1100000 /dev/zero | tr '\\0' a ;;
split) printf '{"loggedIn":true,"authMethod":"claude.ai","email":"a\\303'; sleep 0.2; printf '\\261a@example.com"}' ;;
stuck) stay ;;
esac
[ -n "$FAKE_STAY" ] && stay
exit 0
`,
	);
	await chmod(odd, 0o755);
	return odd;
}
const oddPid = async () => Number((await readFile(join(dir, "odd.pid"), "utf8")).trim());

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "atelier-claude-auth-"));
	await writeFake();
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

it("finds the Claude Code binary of the Agent SDK that Atelier installs", () => {
	const path = bundledClaudeCode();
	expect(path).toMatch(/@anthropic-ai[/\\]claude-agent-sdk-[a-z0-9-]+[/\\]claude(\.exe)?$/);
});

it("reads the account the binary is logged in with, without ANTHROPIC_API_KEY, as the backend runs it", async () => {
	await status({ loggedIn: true, authMethod: "claude.ai", email: "ana@example.com", subscriptionType: "max" });
	const result = await claudeCodeAuthStatus({ executable: fake, env: { ANTHROPIC_API_KEY: "sk-secret" } });
	expect(result).toEqual({
		loggedIn: true,
		authMethod: "claude.ai",
		email: "ana@example.com",
		subscriptionType: "max",
	});
	expect(await calls()).toEqual(["auth status --json key=none"]);
	expect(describeClaudeCodeAuth(result)).toBe("subscription configured (max, ana@example.com)");
});

it("reads a binary that is not logged in, which exits with 1", async () => {
	await status({ loggedIn: false, authMethod: "none" });
	const result = await claudeCodeAuthStatus({ executable: fake, env: {} });
	expect(result).toEqual({ loggedIn: false, authMethod: "none" });
	expect(describeClaudeCodeAuth(result)).toBe("not logged in");
	expect(describeClaudeCodeAuth({ loggedIn: true, authMethod: "api_key" })).toBe(
		"logged in with an Anthropic Console key (billed to the API)",
	);
});

it("fails with a message when the binary is missing or answers something else", async () => {
	const missing = await claudeCodeAuthStatus({ executable: join(dir, "nope"), env: {} }).catch((error) => error);
	expect(missing).toBeInstanceOf(ClaudeCodeAuthError);
	expect(missing.message).toBe("Claude Code binary not found (reinstall Atelier)");
	const login = await claudeCodeLogin({ executable: join(dir, "nope"), env: {}, stdio: "ignore" }).catch((e) => e);
	expect(login.message).toBe("Claude Code binary not found (reinstall Atelier)");
	await writeFile(join(dir, "status.json"), "not json");
	const garbled = await claudeCodeAuthStatus({ executable: fake, env: {} }).catch((error) => error);
	expect(garbled).toBeInstanceOf(ClaudeCodeAuthError);
	expect(garbled.message).toBe("Claude Code's auth status could not be read.");
});

it.skipIf(!canListProcesses)(
	"asks the binary in a process group of its own only when told to, inside a Herdr pane",
	async () => {
		await status({ loggedIn: true, authMethod: "claude.ai" });
		const loggedIn = { loggedIn: true, authMethod: "claude.ai" };
		expect(
			await claudeCodeAuthStatus({ executable: fake, env: { ANTHROPIC_API_KEY: "sk-secret" }, apart: true }),
		).toEqual(loggedIn);
		const apart = await fakeGroup();
		expect(apart).not.toBe(ownGroup());
		// Outside Herdr it runs as it always did, in the group of the process that asks.
		expect(await claudeCodeAuthStatus({ executable: fake, env: {} })).toEqual(loggedIn);
		expect(await fakeGroup()).toBe(ownGroup());
		await status({ loggedIn: false, authMethod: "none" });
		expect(await claudeCodeAuthStatus({ executable: fake, env: {}, apart: true })).toEqual({
			loggedIn: false,
			authMethod: "none",
		});
		const store = new AuthStore(join(dir, "auth.json"));
		expect(await signedInBackends({ executable: fake, env: {}, apart: true, store, platform: "linux" })).toEqual([]);
		expect(await fakeGroup()).not.toBe(ownGroup());
		expect(await calls()).toEqual([
			"auth status --json key=none",
			"auth status --json key=none",
			"auth status --json key=none",
			"auth status --json key=none",
		]);
		const missing = await claudeCodeAuthStatus({ executable: join(dir, "nope"), env: {}, apart: true }).catch((e) => e);
		expect(missing).toBeInstanceOf(ClaudeCodeAuthError);
		expect(missing.message).toBe("Claude Code binary not found (reinstall Atelier)");
		await writeFile(join(dir, "status.json"), "not json");
		const garbled = await claudeCodeAuthStatus({ executable: fake, env: {}, apart: true }).catch((error) => error);
		expect(garbled.message).toBe("Claude Code's auth status could not be read.");
	},
);

describe("the status asked apart", () => {
	it.skipIf(!canListProcesses)("keeps as much of the output as execFile, and fails as it does past that", async () => {
		const odd = await writeOdd();
		const today = await claudeCodeAuthStatus({ executable: odd, env: { FAKE: "big" } }).catch((error) => error);
		expect(today.message).toBe(`Claude Code could not be run (${odd}): stdout maxBuffer length exceeded`);
		const apart = await claudeCodeAuthStatus({
			executable: odd,
			env: { FAKE: "big", FAKE_STAY: "1" },
			apart: true,
		}).catch((error) => error);
		expect(apart).toBeInstanceOf(ClaudeCodeAuthError);
		expect(apart.message).toBe(today.message);
		// The binary, which ignores TERM, is gone too: its group ended after the grace.
		const pid = await oddPid();
		await until(() => !running(pid));
	});

	it.skipIf(!canListProcesses)(
		"gives up on a binary that does not answer in time, and ends its group",
		async () => {
			const odd = await writeOdd();
			const error = await claudeCodeAuthStatus({
				executable: odd,
				env: { FAKE: "stuck" },
				apart: true,
				statusTimeoutMs: 1000,
			}).catch((error) => error);
			expect(error).toBeInstanceOf(ClaudeCodeAuthError);
			expect(error.message).toBe(`Claude Code could not be run (${odd}): no answer within 1000 ms`);
			await until(() => existsSync(join(dir, "odd.pid")));
			const pid = await oddPid();
			await until(() => !running(pid));
		},
		10_000,
	);

	it.skipIf(!canListProcesses)("reads a character that comes in two writes", async () => {
		const odd = await writeOdd();
		const read = { loggedIn: true, authMethod: "claude.ai", email: "aña@example.com" };
		expect(await claudeCodeAuthStatus({ executable: odd, env: { FAKE: "split" }, apart: true })).toEqual(read);
		expect(await claudeCodeAuthStatus({ executable: odd, env: { FAKE: "split" } })).toEqual(read);
	});
});

it("runs Claude Code's own login for a Claude subscription and says how it ended", async () => {
	await status({ loggedIn: false, authMethod: "none" });
	await writeFile(join(dir, "after-login.json"), JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }));
	expect(await claudeCodeLogin({ executable: fake, env: { ANTHROPIC_API_KEY: "sk-secret" }, stdio: "ignore" })).toBe(0);
	expect(await claudeCodeLogin({ executable: fake, env: { FAKE_EXIT: "3" }, stdio: "ignore" })).toBe(3);
	expect(await claudeCodeLogout({ executable: fake, env: {}, stdio: "ignore" })).toBe(0);
	expect(await calls()).toEqual([
		"auth login --claudeai key=none",
		"auth login --claudeai key=none",
		"auth logout key=none",
	]);
	expect(await claudeCodeAuthStatus({ executable: fake, env: {} })).toEqual({ loggedIn: false, authMethod: "none" });
});

describe("loginWarning", () => {
	const store = () => new AuthStore(join(dir, "auth.json"));
	const check = (backend: string, env: Record<string, string> = {}) =>
		loginWarning(backend, { executable: fake, env, store: store(), platform: "linux" });

	it("says how to sign in when Claude Code is not logged in, and offers anthropic-api when there is a key", async () => {
		await status({ loggedIn: false, authMethod: "none" });
		expect(await check("claude-code")).toBe(
			"Claude Code is not logged in: use /login (or atelier login) to sign in with your Claude account.",
		);
		await store().set("anthropic", { type: "api_key", key: "k" });
		expect(await check("claude-code")).toBe(
			"Claude Code is not logged in: use /login (or atelier login) to sign in with your Claude account, or --backend anthropic-api to use your Anthropic API key.",
		);
		expect(await check("claude-code", { OPENCODE_API_KEY: "k" })).toBe(
			"Claude Code is not logged in: use /login (or atelier login) to sign in with your Claude account, or --backend anthropic-api to use your Anthropic API key, or --backend opencode-go to use your OpenCode Go key.",
		);
	});

	it("says nothing when the backend has its login or its key", async () => {
		await status({ loggedIn: true, authMethod: "claude.ai" });
		expect(await check("claude-code")).toBeUndefined();
		expect(await check("anthropic-api", { ANTHROPIC_API_KEY: "k" })).toBeUndefined();
		expect(await check("fake")).toBeUndefined();
	});

	it("says how to sign in to ChatGPT for openai-codex, for the variant forced, and offers it when Claude Code is not logged in", async () => {
		expect(await check("openai-codex")).toBe(
			"Not signed in to ChatGPT for Codex: use /login account openai-codex (or atelier login account openai-codex), or Sign in with ChatGPT with /login account openai-chatgpt.",
		);
		await store().set("openai-codex", { type: "oauth", access: "a", refresh: "r", expires: 1 });
		expect(await check("openai-codex")).toBeUndefined();
		expect(await check("openai-codex", { ATELIER_CODEX_VARIANT: "chatgpt" })).toBe(
			"Not signed in for the chatgpt variant: use /login account openai-chatgpt (or atelier login account openai-chatgpt).",
		);
		expect(await check("openai-codex", { ATELIER_CODEX_VARIANT: "beta" })).toBe(
			'ATELIER_CODEX_VARIANT must be legacy or chatgpt, got "beta".',
		);
		await status({ loggedIn: false, authMethod: "none" });
		expect(await check("claude-code")).toBe(
			"Claude Code is not logged in: use /login (or atelier login) to sign in with your Claude account, or --backend openai-codex to use your ChatGPT sign-in.",
		);
	});

	it("says what is missing for anthropic-api, and why Claude Code could not be asked", async () => {
		expect(await check("anthropic-api")).toBe(MISSING_API_KEY_MESSAGE);
		const missing = await loginWarning("claude-code", { executable: join(dir, "nope"), env: {}, store: store() });
		expect(missing).toBe("Claude Code's login could not be checked: Claude Code binary not found (reinstall Atelier)");
	});

	it("lists the backends with a sign-in, as the warning judges them, from the variables and auth.json", async () => {
		const signedIn = (env: Record<string, string> = {}) =>
			signedInBackends({ executable: fake, env, store: store(), platform: "linux" });
		await status({ loggedIn: false, authMethod: "none" });
		expect(await signedIn()).toEqual([]);
		await status({ loggedIn: true, authMethod: "claude.ai" });
		await store().set("openai-codex", { type: "oauth", access: "a", refresh: "r", expires: 1 });
		expect(await signedIn()).toEqual(["claude-code", "openai-codex"]);
		await store().set("opencode-go", { type: "api_key", key: "k" });
		expect(await signedIn({ ANTHROPIC_API_KEY: "k" })).toEqual([
			"claude-code",
			"anthropic-api",
			"opencode-go",
			"openai-codex",
		]);
		const missing = await signedInBackends({
			executable: join(dir, "nope"),
			env: {},
			store: store(),
			platform: "linux",
		});
		expect(missing).toEqual(["opencode-go", "openai-codex"]);
	});

	it("says when opencode-go has no key, from OPENCODE_API_KEY or atelier login", async () => {
		expect(await check("opencode-go")).toBe(MISSING_OPENCODE_GO_KEY_MESSAGE);
		// An Anthropic key is not an OpenCode Go key.
		expect(await check("opencode-go", { ANTHROPIC_API_KEY: "k" })).toBe(MISSING_OPENCODE_GO_KEY_MESSAGE);
		expect(await check("opencode-go", { OPENCODE_API_KEY: "k" })).toBeUndefined();
		await store().set("opencode-go", { type: "api_key", key: "k" });
		expect(await check("opencode-go")).toBeUndefined();
	});
});
