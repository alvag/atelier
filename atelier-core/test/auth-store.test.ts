import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuthStore, AuthStoreError, authFile, type Credential } from "../src/auth-store.ts";
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

it("lists every stored key and token, to hide them, and nothing of an entry it does not know", async () => {
	const store = new AuthStore(file);
	await store.set("anthropic", { type: "api_key", key: "sk-ant-test-1" });
	await store.set("openai-codex", { type: "oauth", access: "a-1", refresh: "r-1", expires: 1 });
	expect(store.secrets()).toEqual(["sk-ant-test-1", "a-1", "r-1"]);
});

it("refreshes a stale credential under the lock, and leaves a fresh one alone", async () => {
	const store = new AuthStore(file);
	await store.set("openai-codex", { type: "oauth", access: "a-1", refresh: "r-1", expires: Date.now() + 3_600_000 });
	const refresh = async () => ({
		type: "oauth" as const,
		access: "a-2",
		refresh: "r-2",
		expires: Date.now() + 7_200_000,
	});
	const stale = (credential: Credential) => credential.type === "oauth" && credential.expires < Date.now() + 60_000;
	expect(await store.refreshed("openai-codex", stale, refresh)).toMatchObject({ access: "a-1" });
	expect(await store.refreshed("openai-codex", () => true, refresh)).toMatchObject({ access: "a-2", refresh: "r-2" });
	expect(store.get("openai-codex")).toMatchObject({ access: "a-2", refresh: "r-2" });
	expect(await store.refreshed("missing", () => true, refresh)).toBeUndefined();
	await expect(
		store.refreshed(
			"openai-codex",
			() => true,
			async () => Promise.reject(new Error("refused")),
		),
	).rejects.toThrow("refused");
	expect(store.get("openai-codex")).toMatchObject({ access: "a-2" });
	expect(await readdir(join(home, ".atelier"))).not.toContain("auth.json.lock");
});

it("refreshes once when several processes find the credential stale at the same time", async () => {
	const store = new AuthStore(file);
	await store.set("openai-codex", { type: "oauth", access: "a-0", refresh: "r-0", expires: 0 });
	const module = new URL("../src/auth-store.ts", import.meta.url).href;
	const count = join(home, "refreshes");
	const refresher = () =>
		new Promise<string>((resolve) => {
			// The refresh outlasts the stale-lock age: the heartbeat keeps the others from taking the lock over.
			const script = `const { AuthStore } = await import(${JSON.stringify(module)});
const { appendFileSync } = await import("node:fs");
const store = new AuthStore(${JSON.stringify(file)}, { staleLockMs: 300 });
const got = await store.refreshed("openai-codex", (c) => c.expires < Date.now(), async (c) => {
	appendFileSync(${JSON.stringify(count)}, c.refresh + "\\n");
	await new Promise((r) => setTimeout(r, 900));
	return { type: "oauth", access: "a-1", refresh: "r-1", expires: Date.now() + 3600000 };
});
process.stdout.write(got.access);`;
			let out = "";
			const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
				stdio: ["ignore", "pipe", "inherit"],
			});
			child.stdout.on("data", (chunk: Buffer) => {
				out += chunk.toString();
			});
			child.on("exit", () => resolve(out));
		});
	expect(await Promise.all([refresher(), refresher(), refresher()])).toEqual(["a-1", "a-1", "a-1"]);
	expect(await readFile(count, "utf8")).toBe("r-0\n");
});

/** A refresher in another process whose refresh never ends: says `ready` once it holds the lock, then waits. */
function stuckRefresher(staleLockMs: number) {
	const module = new URL("../src/auth-store.ts", import.meta.url).href;
	const script = `const { AuthStore } = await import(${JSON.stringify(module)});
const store = new AuthStore(${JSON.stringify(file)}, { staleLockMs: ${staleLockMs} });
await store.refreshed("openai-codex", () => true, async () => {
	process.stdout.write("ready");
	await new Promise((r) => setTimeout(r, 60000));
	throw new Error("unreachable");
});`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	const ready = new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	return { child, ready, exited };
}

it("never takes the lock from a live holder, even one stalled past the stale age, so a refresh token is sent once", async () => {
	await new AuthStore(file).set("openai-codex", { type: "oauth", access: "a-0", refresh: "r-0", expires: 0 });
	const before = await readFile(file);
	const holder = stuckRefresher(150);
	try {
		await holder.ready;
		// Stopped, it renews nothing: the lock only grows old.
		holder.child.kill("SIGSTOP");
		const lock = `${file}.lock`;
		while (Date.now() - (await stat(lock)).mtimeMs <= 300) await new Promise((resolve) => setTimeout(resolve, 10));
		let refreshes = 0;
		const waiting = new AuthStore(file, { staleLockMs: 150, refreshLockTimeoutMs: 300 });
		const failed = await waiting
			.refreshed(
				"openai-codex",
				() => true,
				async () => {
					refreshes++;
					return { type: "oauth", access: "a-1", refresh: "r-1", expires: Date.now() + 3_600_000 };
				},
			)
			.catch((error: unknown) => error);
		expect(failed).toBeInstanceOf(AuthStoreError);
		expect(refreshes).toBe(0);
		expect(await readFile(file)).toEqual(before);
	} finally {
		holder.child.kill("SIGKILL");
		await holder.exited;
	}
});

it("takes the lock of a holder that died at once, and leaves the credential as it was", async () => {
	await new AuthStore(file).set("openai-codex", { type: "oauth", access: "a-0", refresh: "r-0", expires: 0 });
	const before = await readFile(file);
	// A stale age far longer than the test: only the dead process's id lets the lock go.
	const holder = stuckRefresher(60_000);
	await holder.ready;
	holder.child.kill("SIGKILL");
	await holder.exited;
	expect(await readFile(file)).toEqual(before);
	const store = new AuthStore(file, { staleLockMs: 60_000, lockTimeoutMs: 1_000 });
	await store.set("anthropic", { type: "api_key", key: "k" });
	expect(store.get("openai-codex")).toEqual({ type: "oauth", access: "a-0", refresh: "r-0", expires: 0 });
});
