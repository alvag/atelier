import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findReceipt,
	findReceipts,
	latestCorrection,
	type Receipt,
	replaceReceipt,
	writeReceipt,
} from "../src/review/receipts.ts";

const TREE = "a".repeat(40);
const receipt = (over: Partial<Receipt> = {}): Receipt => ({
	schema: "atelier.review-receipt/v1",
	id: "r1",
	createdAt: "2026-10-22T10:00:00.000Z",
	base: "b".repeat(40),
	candidate: TREE,
	corrected: null,
	risk: { level: "high", reasons: ["path: src/auth/session.ts"] },
	lenses: ["risk"],
	findings: [],
	refuted: [],
	followUps: [],
	correction: null,
	verdict: "approved",
	usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
	...over,
});

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) {
		await chmod(dir, 0o700).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
});
const scratch = async () => {
	const dir = await mkdtemp(join(tmpdir(), "atelier-receipt-test-"));
	dirs.push(dir);
	return dir;
};

describe("receipts", () => {
	it("writes <gitDir>/atelier/reviews/<candidate tree>-<review id>.json with mode 0600 and reads it back", async () => {
		const gitDir = await scratch();
		await writeReceipt(gitDir, receipt());
		const file = join(gitDir, "atelier", "reviews", `${TREE}-r1.json`);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(await findReceipt(gitDir, TREE)).toEqual(receipt());
		expect(await readdir(join(gitDir, "atelier", "reviews"))).toEqual([`${TREE}-r1.json`]);
	});

	it("round-trips the optional fields", async () => {
		const gitDir = await scratch();
		const full = receipt({
			verdict: "unavailable",
			unavailableReason: "lens_context_budget_exceeded",
			costUsd: 0.5,
			correction: { budget: 4, used: 2 },
			corrected: "c".repeat(40),
		});
		await writeReceipt(gitDir, full);
		expect(await findReceipt(gitDir, TREE)).toEqual(full);
	});

	it("keeps one file per review of the same candidate, both readable, and finds the most recent", async () => {
		const gitDir = await scratch();
		const first = receipt({ id: "r1", verdict: "declined", createdAt: "2026-10-22T10:00:00.000Z" });
		const second = receipt({ id: "r2", verdict: "approved", createdAt: "2026-10-22T11:00:00.000Z" });
		await writeReceipt(gitDir, second);
		await writeReceipt(gitDir, first);
		expect((await readdir(join(gitDir, "atelier", "reviews"))).sort()).toEqual([`${TREE}-r1.json`, `${TREE}-r2.json`]);
		expect((await findReceipts(gitDir, TREE)).map((stored) => stored.receipt)).toEqual([second, first]);
		expect(await findReceipt(gitDir, TREE)).toEqual(second);
	});

	it("reads a legacy <tree>.json receipt, and it is the latest when it is newer", async () => {
		const gitDir = await scratch();
		const reviews = join(gitDir, "atelier", "reviews");
		await mkdir(reviews, { recursive: true });
		const legacy = receipt({ id: "old", verdict: "declined", createdAt: "2026-10-22T12:00:00.000Z" });
		await writeFile(join(reviews, `${TREE}.json`), `${JSON.stringify(legacy, null, 2)}\n`);
		expect(await findReceipt(gitDir, TREE)).toEqual(legacy);
		await writeReceipt(gitDir, receipt({ id: "r1", createdAt: "2026-10-22T10:00:00.000Z" }));
		expect(await findReceipt(gitDir, TREE)).toEqual(legacy);
		await writeReceipt(gitDir, receipt({ id: "r2", verdict: "escalated", createdAt: "2026-10-22T13:00:00.000Z" }));
		expect((await findReceipt(gitDir, TREE))?.id).toBe("r2");
		expect(await readdir(reviews)).toContain(`${TREE}.json`);
	});

	it("does not mix up the receipts of two trees", async () => {
		const gitDir = await scratch();
		const other = "d".repeat(40);
		await writeReceipt(gitDir, receipt({ id: "r1" }));
		await writeReceipt(gitDir, receipt({ id: "r2", candidate: other, createdAt: "2026-10-23T10:00:00.000Z" }));
		expect((await findReceipt(gitDir, TREE))?.id).toBe("r1");
		expect((await findReceipt(gitDir, other))?.id).toBe("r2");
	});

	it("finds the latest correction across trees and across receipts of one tree, legacy files included", async () => {
		const gitDir = await scratch();
		const reviews = join(gitDir, "atelier", "reviews");
		const other = "d".repeat(40);
		const fix = (over: Partial<Receipt>) => receipt({ verdict: "escalated", corrected: "c".repeat(40), ...over });
		await writeReceipt(gitDir, fix({ id: "a1", createdAt: "2026-10-22T10:00:00.000Z" }));
		await writeReceipt(gitDir, fix({ id: "b1", candidate: other, createdAt: "2026-10-22T11:00:00.000Z" }));
		expect((await latestCorrection(gitDir))?.id).toBe("b1");
		await writeReceipt(gitDir, fix({ id: "a2", createdAt: "2026-10-22T12:00:00.000Z" }));
		expect((await latestCorrection(gitDir))?.id).toBe("a2");
		await writeFile(
			join(reviews, `${other}.json`),
			JSON.stringify(fix({ id: "legacy", candidate: other, createdAt: "2026-10-22T13:00:00.000Z" })),
		);
		expect((await latestCorrection(gitDir))?.id).toBe("legacy");
		await writeReceipt(gitDir, receipt({ id: "a3", createdAt: "2026-10-22T14:00:00.000Z" }));
		expect((await latestCorrection(gitDir))?.id).toBe("legacy");
	});

	it("replaces one receipt in place and leaves the other of the same tree byte-identical", async () => {
		const gitDir = await scratch();
		const reviews = join(gitDir, "atelier", "reviews");
		await writeReceipt(gitDir, receipt({ id: "r1", createdAt: "2026-10-22T10:00:00.000Z" }));
		await writeReceipt(gitDir, receipt({ id: "r2", createdAt: "2026-10-22T11:00:00.000Z" }));
		const before = await readFile(join(reviews, `${TREE}-r2.json`));
		const [, older] = await findReceipts(gitDir, TREE);
		await replaceReceipt(gitDir, older?.file as string, {
			...(older?.receipt as Receipt),
			undoneAt: "2026-10-23T00:00:00.000Z",
		});
		expect(await readFile(join(reviews, `${TREE}-r2.json`))).toEqual(before);
		expect((await readdir(reviews)).sort()).toEqual([`${TREE}-r1.json`, `${TREE}-r2.json`]);
		expect(JSON.parse(await readFile(join(reviews, `${TREE}-r1.json`), "utf8"))).toMatchObject({
			undoneAt: "2026-10-23T00:00:00.000Z",
		});
	});

	it("reads an old receipt with major and minor as warning and suggestion, and leaves the file as it was", async () => {
		const gitDir = await scratch();
		const reviews = join(gitDir, "atelier", "reviews");
		await mkdir(reviews, { recursive: true });
		const found = (severity: string, id: string) => ({
			id,
			lens: "risk",
			severity,
			cause: "candidate",
			path: "a.ts",
			claim: "c",
			evidence: "a.ts:1",
		});
		const text = JSON.stringify({
			...receipt(),
			findings: [found("critical", "RK-001")],
			refuted: [{ ...found("major", "RK-002"), reason: "guarded" }],
			followUps: [found("major", "RK-003"), found("minor", "RK-004")],
		});
		await writeFile(join(reviews, `${TREE}.json`), text);
		const read = await findReceipt(gitDir, TREE);
		expect(read?.findings.map((f) => f.severity)).toEqual(["critical"]);
		expect(read?.refuted.map((f) => f.severity)).toEqual(["warning"]);
		expect(read?.followUps.map((f) => f.severity)).toEqual(["warning", "suggestion"]);
		expect(await readFile(join(reviews, `${TREE}.json`), "utf8")).toBe(text);
	});

	it("returns undefined when there is no receipt, or the file is corrupt or has the wrong shape", async () => {
		const gitDir = await scratch();
		expect(await findReceipt(gitDir, TREE)).toBeUndefined();
		const reviews = join(gitDir, "atelier", "reviews");
		await mkdir(reviews, { recursive: true });
		await writeFile(join(reviews, `${TREE}.json`), "{ not json");
		expect(await findReceipt(gitDir, TREE)).toBeUndefined();
		await writeFile(join(reviews, `${TREE}.json`), JSON.stringify({ schema: "other" }));
		expect(await findReceipt(gitDir, TREE)).toBeUndefined();
		expect(await findReceipt(gitDir, "../../etc/passwd")).toBeUndefined();
	});

	it("refuses a tree name that could leave the reviews directory", async () => {
		const gitDir = await scratch();
		await expect(writeReceipt(gitDir, receipt({ candidate: "../evil" }))).rejects.toThrow();
		expect(await readdir(gitDir)).toEqual([]);
	});

	it("leaves no partial file when the write fails", async () => {
		const gitDir = await scratch();
		const reviews = join(gitDir, "atelier", "reviews");
		// A directory where the receipt belongs makes the final rename fail.
		await mkdir(join(reviews, `${TREE}-r1.json`), { recursive: true });
		await expect(writeReceipt(gitDir, receipt())).rejects.toThrow();
		expect(await readdir(reviews)).toEqual([`${TREE}-r1.json`]);
	});

	it("never touches the worktree: git status is unchanged after writing", async () => {
		const root = await scratch();
		const git = (...args: string[]) =>
			execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
		git("init", "-q");
		await writeFile(join(root, "a.txt"), "one\n");
		git("add", "-A");
		git("commit", "-qm", "init");
		await writeFile(join(root, "b.txt"), "two\n");
		const before = git("status", "--porcelain");
		await writeReceipt(join(root, ".git"), receipt());
		expect(git("status", "--porcelain")).toBe(before);
		expect((await readdir(root)).sort()).toEqual([".git", "a.txt", "b.txt"]);
	});

	it.each(["atelier", "reviews"])("refuses a symlinked %s directory and writes nothing through it", async (part) => {
		const gitDir = await scratch();
		const outside = await scratch();
		if (part === "reviews") await mkdir(join(gitDir, "atelier"));
		const link = part === "atelier" ? join(gitDir, "atelier") : join(gitDir, "atelier", "reviews");
		await symlink(outside, link);
		await expect(writeReceipt(gitDir, receipt())).rejects.toThrow();
		expect(await readdir(outside)).toEqual([]);
	});
});
