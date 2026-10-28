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
} from "../src/claude-code-auth.ts";
import { MISSING_API_KEY_MESSAGE, MISSING_OPENCODE_GO_KEY_MESSAGE } from "../src/credentials.ts";
import { requireIsolatedHome } from "./support/login-isolation.ts";

requireIsolatedHome();

let dir: string;
let fake: string;

/**
 * A stand-in for the Claude Code binary: it logs its arguments and whether it got ANTHROPIC_API_KEY, prints
 * `$dir/status.json` for `auth status --json` (exit 1 when not logged in, as Claude Code does), and `auth login`
 * writes `$dir/after-login.json` over it.
 */
async function writeFake(): Promise<void> {
	fake = join(dir, "claude");
	await writeFile(
		fake,
		`#!/bin/sh
echo "$* key=\${ANTHROPIC_API_KEY:-none}" >> "${dir}/calls.log"
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

	it("says when opencode-go has no key, from OPENCODE_API_KEY or atelier login", async () => {
		expect(await check("opencode-go")).toBe(MISSING_OPENCODE_GO_KEY_MESSAGE);
		// An Anthropic key is not an OpenCode Go key.
		expect(await check("opencode-go", { ANTHROPIC_API_KEY: "k" })).toBe(MISSING_OPENCODE_GO_KEY_MESSAGE);
		expect(await check("opencode-go", { OPENCODE_API_KEY: "k" })).toBeUndefined();
		await store().set("opencode-go", { type: "api_key", key: "k" });
		expect(await check("opencode-go")).toBeUndefined();
	});
});
