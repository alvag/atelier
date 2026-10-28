import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuthStore, AuthStoreError, authFile } from "../src/auth-store.ts";
import { requireIsolatedHome } from "./support/login-isolation.ts";

requireIsolatedHome();

let home: string;
let file: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-auth-store-"));
	file = authFile(home);
});

afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

it("keeps each provider's credential in ~/.atelier/auth.json, 0600 in a 0700 folder", async () => {
	const store = new AuthStore(file);
	await store.set("anthropic", { type: "api_key", key: "sk-ant-test-1" });
	await store.set("openai-codex", { type: "oauth", access: "a-1", refresh: "r-1", expires: 1_900_000_000_000 });
	expect(file).toBe(join(home, ".atelier", "auth.json"));
	expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
		anthropic: { type: "api_key", key: "sk-ant-test-1" },
		"openai-codex": { type: "oauth", access: "a-1", refresh: "r-1", expires: 1_900_000_000_000 },
	});
	expect((await stat(file)).mode & 0o777).toBe(0o600);
	expect((await stat(join(home, ".atelier"))).mode & 0o777).toBe(0o700);
	expect(new AuthStore(file).get("anthropic")).toEqual({ type: "api_key", key: "sk-ant-test-1" });
	expect((await readdir(join(home, ".atelier"))).sort()).toEqual([".credentials-tmp", "auth.json"]);
	expect(await readdir(join(home, ".atelier", ".credentials-tmp"))).toEqual([]);
});

it("removes a provider and says whether it had one", async () => {
	const store = new AuthStore(file);
	await store.set("anthropic", { type: "api_key", key: "sk-ant-test-1" });
	expect(await store.remove("anthropic")).toBe(true);
	expect(await store.remove("anthropic")).toBe(false);
	expect(store.get("anthropic")).toBeUndefined();
	expect(store.providers()).toEqual([]);
});

it("ignores a missing or malformed file, and entries of an unknown shape, but keeps them when it writes", async () => {
	const store = new AuthStore(file);
	expect(store.get("anthropic")).toBeUndefined();
	await mkdir(join(home, ".atelier"), { recursive: true });
	await writeFile(file, "{not json");
	expect(store.get("anthropic")).toBeUndefined();
	await writeFile(file, JSON.stringify({ anthropic: { type: "api_key" }, future: { type: "other", x: 1 } }));
	expect(store.get("anthropic")).toBeUndefined();
	expect(store.providers()).toEqual([]);
	await store.set("opencode-go", { type: "api_key", key: "oc-1" });
	expect(JSON.parse(await readFile(file, "utf8")).future).toEqual({ type: "other", x: 1 });
});

it("sets a file left readable by others back to 0600 when it reads it", async () => {
	const store = new AuthStore(file);
	await store.set("anthropic", { type: "api_key", key: "sk-ant-test-1" });
	await chmod(file, 0o644);
	expect(store.get("anthropic")).toEqual({ type: "api_key", key: "sk-ant-test-1" });
	expect((await stat(file)).mode & 0o777).toBe(0o600);
});

it("waits for another process's lock, and fails with a message when it never goes", async () => {
	const store = new AuthStore(file, { lockTimeoutMs: 150, staleLockMs: 60_000 });
	await mkdir(join(home, ".atelier"), { recursive: true });
	await writeFile(`${file}.lock`, "");
	const failed = await store.set("anthropic", { type: "api_key", key: "k" }).catch((error: unknown) => error);
	expect(failed).toBeInstanceOf(AuthStoreError);
	expect((failed as Error).message).toBe(`${file} is locked by another Atelier (${file}.lock); try again`);
	expect(store.get("anthropic")).toBeUndefined();
});

it("takes over a lock left behind by a process that died", async () => {
	const store = new AuthStore(file, { lockTimeoutMs: 1_000, staleLockMs: 5_000 });
	await mkdir(join(home, ".atelier"), { recursive: true });
	await writeFile(`${file}.lock`, "");
	const old = new Date(Date.now() - 60_000);
	await utimes(`${file}.lock`, old, old);
	await store.set("anthropic", { type: "api_key", key: "k" });
	expect(store.get("anthropic")).toEqual({ type: "api_key", key: "k" });
	expect((await readdir(join(home, ".atelier"))).sort()).toEqual([".credentials-tmp", "auth.json"]);
	expect(await readdir(join(home, ".atelier", ".credentials-tmp"))).toEqual([]);
});

it("loses no change when several processes write at once", async () => {
	const module = new URL("../src/auth-store.ts", import.meta.url).href;
	const writer = (name: string) =>
		new Promise<number | null>((resolve) => {
			const script = `const { AuthStore } = await import(${JSON.stringify(module)});
const store = new AuthStore(${JSON.stringify(file)});
for (let i = 0; i < 10; i++) await store.set(${JSON.stringify(name)} + "-" + i, { type: "api_key", key: "k" + i });`;
			const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "inherit" });
			child.on("exit", resolve);
		});
	expect(await Promise.all(["a", "b", "c"].map(writer))).toEqual([0, 0, 0]);
	expect(new AuthStore(file).providers()).toHaveLength(30);
});
