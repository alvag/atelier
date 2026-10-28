import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sweepStaleScratch } from "../src/scratch.ts";

vi.mock("node:child_process", async (original) => ({
...await original<typeof import("node:child_process")>(), execFile: vi.fn(),
}));
let root: string;
const T = 1_700_000_000_000;
const hash = async (p: string) => createHash("sha256").update(await readFile(p)).digest("hex");
async function fixture(name = "atelier-session-AAAAAA") {
const dir = join(root, name);
await mkdir(join(dir, "work"), { recursive: true });
await writeFile(join(dir, ".atelier-owner"), JSON.stringify({ pid: 4242, startedAt: T }));
await writeFile(join(dir, "work", "sentinel"), "must survive");
return dir;
}
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "independent-sweep-")); });
afterEach(() => { vi.restoreAllMocks(); });

// Approved design: real directory, same owner, throughout deletion; never follow links.
it("does not follow a directory replaced by a symlink during the owner check", async () => {
const dir = await fixture();
const target = await fixture("not-atelier");
const sentinel = join(target, "work", "sentinel");
const before = await hash(sentinel);
await sweepStaleScratch({ tmpRoot: root, processes: {
isAlive: () => true,
startedAt: async () => {
await rename(dir, join(root, "retired"));
await symlink(target, dir);
return T + 6000;
},
} });
expect(await hash(sentinel)).toBe(before);
});

it("does not delete a new live directory replacing the checked one", async () => {
const dir = await fixture();
await sweepStaleScratch({ tmpRoot: root, processes: {
isAlive: () => true,
startedAt: async () => {
await rename(dir, join(root, "retired"));
await fixture();
await writeFile(join(dir, ".atelier-owner"), JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
return T + 6000;
},
} });
expect(await readFile(join(dir, "work", "sentinel"), "utf8")).toBe("must survive");
});

// Approved design: EPERM is uncertainty, not permission to use ps and delete.
it("keeps the directory when kill returns EPERM even if ps suggests reuse", async () => {
const dir = await fixture();
const sentinel = join(dir, "work", "sentinel");
const before = await hash(sentinel);
vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
(args.at(-1) as (...a: unknown[]) => void)(null, "00:01", "");
return {};
}) as typeof execFile);
await sweepStaleScratch({ tmpRoot: root });
expect(await hash(sentinel)).toBe(before);
});

// Approved design: Windows is uncertain and must keep directories.
it("does not delete on Windows when kill returns ESRCH", async () => {
const dir = await fixture();
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
Object.defineProperty(process, "platform", { value: "win32", configurable: true });
vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
try {
await sweepStaleScratch({ tmpRoot: root });
expect(await readFile(join(dir, "work", "sentinel"), "utf8")).toBe("must survive");
} finally { Object.defineProperty(process, "platform", platform); }
});

it("keeps an unreadable owner byte-identical", async () => {
const dir = await fixture();
const owner = join(dir, ".atelier-owner");
const before = await hash(join(dir, "work", "sentinel"));
await chmod(owner, 0);
try {
expect(await sweepStaleScratch({ tmpRoot: root, processes: { isAlive: () => false, startedAt: async () => undefined } })).toEqual([]);
expect(await hash(join(dir, "work", "sentinel"))).toBe(before);
} finally { await chmod(owner, 0o600); }
});

it("unlinks nested symlinks without recursively deleting their targets", async () => {
const dir = await fixture();
const target = await fixture("ordinary-directory");
const before = await hash(join(target, "work", "sentinel"));
await symlink(target, join(dir, "work", "link"));
await sweepStaleScratch({ tmpRoot: root, processes: { isAlive: () => false, startedAt: async () => undefined } });
expect(await hash(join(target, "work", "sentinel"))).toBe(before);
});

it("keeps another uid's directory", async () => {
const dir = await fixture();
const uid = (await lstat(dir)).uid;
vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
expect(await sweepStaleScratch({ tmpRoot: root, processes: { isAlive: () => false, startedAt: async () => undefined } })).toEqual([]);
expect(await readFile(join(dir, "work", "sentinel"), "utf8")).toBe("must survive");
});

it("bounds ps and keeps the directory when ps fails", async () => {
const dir = await fixture();
vi.spyOn(process, "kill").mockReturnValue(true);
vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
expect(args[2]).toMatchObject({ timeout: 5000, env: { LC_ALL: "C" } });
(args.at(-1) as (...a: unknown[]) => void)(new Error("timeout"), "", "");
return {};
}) as typeof execFile);
expect(await sweepStaleScratch({ tmpRoot: root })).toEqual([]);
expect(await readFile(join(dir, "work", "sentinel"), "utf8")).toBe("must survive");
});

it("preserves the owner if removing an unexpected root child fails", async () => {
const dir = await fixture();
const locked = join(dir, "locked");
await mkdir(locked);
await writeFile(join(locked, "sentinel"), "retry me");
await chmod(locked, 0o500);
try {
expect(await sweepStaleScratch({ tmpRoot: root, processes: { isAlive: () => false, startedAt: async () => undefined } })).toEqual([]);
expect(JSON.parse(await readFile(join(dir, ".atelier-owner"), "utf8"))).toMatchObject({ pid: 4242 });
} finally { await chmod(locked, 0o700); }
});

it("uses exactly 5000 milliseconds, not a larger reuse margin", async () => {
const at = await fixture("atelier-session-AAAAAA");
const past = await fixture("atelier-session-BBBBBB");
const removed = await sweepStaleScratch({ tmpRoot: root, processes: {
isAlive: () => true, startedAt: async () => T + 5000,
} });
expect(removed).toEqual([]);
await writeFile(join(past, ".atelier-owner"), JSON.stringify({ pid: 4242, startedAt: T - 1 }));
expect(await sweepStaleScratch({ tmpRoot: root, processes: { isAlive: () => true, startedAt: async () => T + 5000 } })).toEqual([past]);
expect(await readFile(join(at, "work", "sentinel"), "utf8")).toBe("must survive");
});
