import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore, authFile } from "@atelier/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { type LoginOption, type LoginPorts, login, logout, parseLoginTarget } from "../src/login.ts";

let home: string;
let fake: string;

/** A stand-in for Claude Code: `auth status` prints `status.json`, `auth login` and `auth logout` change it. */
async function writeFake(): Promise<void> {
	fake = join(home, "claude");
	await writeFile(
		fake,
		`#!/bin/sh
echo "$*" >> "${home}/calls.log"
case "$1 $2" in
"auth status") cat "${home}/status.json"; grep -q '"loggedIn":true' "${home}/status.json" ;;
"auth login") echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}' > "${home}/status.json" ;;
"auth logout") echo '{"loggedIn":false,"authMethod":"none"}' > "${home}/status.json" ;;
esac
`,
	);
	await chmod(fake, 0o755);
}

const loggedOut = () => writeFile(join(home, "status.json"), '{"loggedIn":false,"authMethod":"none"}');
const calls = async () => (await readFile(join(home, "calls.log"), "utf8").catch(() => "")).trim().split("\n");

/** Ports that answer from lists and record what was shown. */
function ports(options: { choices?: number[]; secrets?: string[]; confirms?: boolean[]; interactive?: boolean } = {}) {
	const shown: string[] = [];
	const lists: { title: string; options: readonly LoginOption[] }[] = [];
	let handedOver = 0;
	const value: LoginPorts = {
		home,
		env: {},
		claudeCode: fake,
		platform: "linux",
		interactive: options.interactive ?? true,
		choose: async (title, list) => {
			lists.push({ title, options: list });
			return options.choices?.shift();
		},
		askSecret: async (prompt) => {
			shown.push(`ask: ${prompt}`);
			return options.secrets?.shift();
		},
		confirm: async (question) => {
			shown.push(`confirm: ${question}`);
			return options.confirms?.shift() ?? false;
		},
		handOver: async (task) => {
			handedOver++;
			return task();
		},
		say: (text) => shown.push(text),
		fail: (text) => shown.push(`error: ${text}`),
	};
	return { value, shown, lists, handedOvers: () => handedOver };
}

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-login-"));
	await writeFake();
	await loggedOut();
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

it("parses the method and the provider, each optional", () => {
	expect(parseLoginTarget([])).toEqual({});
	expect(parseLoginTarget(["api-key"])).toEqual({ method: "api-key" });
	expect(parseLoginTarget(["account", "anthropic"])).toEqual({ method: "account", provider: "anthropic" });
	expect(parseLoginTarget(["anthropic"])).toEqual({ provider: "anthropic" });
	expect(parseLoginTarget(["api-key", "anthropic", "x"])).toBeUndefined();
});

it("asks the method, then the provider with its state, and stores an API key it never shows", async () => {
	const p = ports({ choices: [1, 0], secrets: ["  sk-ant-new  "] });
	expect(await login(p.value)).toBe(true);
	expect(p.lists).toEqual([
		{
			title: "Select authentication method",
			options: [{ label: "Sign in with an account" }, { label: "Sign in with an API key" }],
		},
		{ title: "Sign in with an API key", options: [{ label: "Anthropic", status: "not configured" }] },
	]);
	expect(new AuthStore(authFile(home)).get("anthropic")).toEqual({ type: "api_key", key: "sk-ant-new" });
	expect(p.shown).toEqual([
		"ask: Anthropic API key (hidden): ",
		"✓ Anthropic: API key stored in ~/.atelier/auth.json; --backend anthropic-api uses it.",
	]);
	expect(JSON.stringify(p.shown)).not.toContain("sk-ant-new");
	const again = ports({ choices: [0] });
	await login(again.value, { method: "api-key" });
	expect(again.lists[0]?.options).toEqual([{ label: "Anthropic", status: "✓ stored" }]);
});

it("changes nothing when no key is given or the list is cancelled", async () => {
	const empty = ports({ secrets: [""] });
	expect(await login(empty.value, { method: "api-key", provider: "anthropic" })).toBe(false);
	expect(empty.shown.at(-1)).toBe("error: no key given; nothing changed");
	const cancelled = ports({ choices: [] });
	expect(await login(cancelled.value)).toBe(false);
	expect(cancelled.shown).toEqual(["Nothing changed."]);
	const unknown = ports();
	expect(await login(unknown.value, { method: "api-key", provider: "nope" })).toBe(false);
	expect(unknown.shown).toEqual(['error: unknown provider "nope" for an API key; the providers are: anthropic']);
	expect(new AuthStore(authFile(home)).providers()).toEqual([]);
});

it("hands the terminal to Claude Code's own sign-in and checks that it is logged in afterwards", async () => {
	const p = ports({ choices: [0] });
	expect(await login(p.value, { method: "account" })).toBe(true);
	expect(p.lists[0]?.options).toEqual([{ label: "Anthropic", status: "not logged in" }]);
	expect(p.handedOvers()).toBe(1);
	expect(await calls()).toEqual(["auth status --json", "auth login --claudeai", "auth status --json"]);
	expect(p.shown.at(-1)).toBe("✓ Anthropic: subscription configured (max). The claude-code backend uses it.");
});

it("says the account sign-in needs a terminal, and runs nothing", async () => {
	const p = ports({ interactive: false });
	expect(await login(p.value, { method: "account", provider: "anthropic" })).toBe(false);
	expect(p.shown).toEqual(["error: signing in with an account needs a terminal: run atelier login in one"]);
	expect(await calls()).toEqual([""]);
});

it("signs out of a stored key, and of Claude Code only once it is confirmed", async () => {
	await new AuthStore(authFile(home)).set("anthropic", { type: "api_key", key: "k" });
	await writeFile(join(home, "status.json"), '{"loggedIn":true,"authMethod":"claude.ai"}');
	const declined = ports({ choices: [1], confirms: [false] });
	expect(await logout(declined.value)).toBe(false);
	expect(declined.lists[0]).toEqual({
		title: "Select what to sign out of",
		options: [
			{ method: "api-key", provider: "anthropic", label: "Anthropic API key", status: "✓ stored" },
			{
				method: "account",
				provider: "anthropic",
				label: "Anthropic account (Claude Code)",
				status: "subscription configured",
			},
		],
	});
	expect(declined.shown).toEqual([
		"confirm: Signing out of Anthropic signs out Claude Code on this machine too: the claude command and anything else that uses its login. Sign out?",
		"Nothing changed.",
	]);
	expect(await calls()).not.toContain("auth logout");
	const confirmed = ports({ confirms: [true] });
	expect(await logout(confirmed.value, { method: "account" })).toBe(true);
	expect(confirmed.shown.at(-1)).toBe("Signed out of Claude Code.");
	const key = ports();
	expect(await logout(key.value, { provider: "anthropic" })).toBe(true);
	expect(key.shown).toEqual(["Anthropic API key removed from ~/.atelier/auth.json."]);
	expect(new AuthStore(authFile(home)).providers()).toEqual([]);
	const nothing = ports();
	expect(await logout(nothing.value)).toBe(true);
	expect(nothing.shown).toEqual(["Nothing to sign out of."]);
});
