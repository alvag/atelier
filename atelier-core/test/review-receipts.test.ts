import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findReceipt, type Receipt, writeReceipt } from "../src/review/receipts.ts";

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
	it("writes <gitDir>/atelier/reviews/<candidate tree>.json with mode 0600 and reads it back", async () => {
		const gitDir = await scratch();
		await writeReceipt(gitDir, receipt());
		const file = join(gitDir, "atelier", "reviews", `${TREE}.json`);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(await findReceipt(gitDir, TREE)).toEqual(receipt());
		expect(await readdir(join(gitDir, "atelier", "reviews"))).toEqual([`${TREE}.json`]);
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

	it("replaces an earlier receipt of the same candidate", async () => {
		const gitDir = await scratch();
		await writeReceipt(gitDir, receipt({ verdict: "declined" }));
		await writeReceipt(gitDir, receipt({ verdict: "approved" }));
		expect((await findReceipt(gitDir, TREE))?.verdict).toBe("approved");
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
		await mkdir(join(reviews, `${TREE}.json`), { recursive: true });
		await expect(writeReceipt(gitDir, receipt())).rejects.toThrow();
		expect(await readdir(reviews)).toEqual([`${TREE}.json`]);
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
});
