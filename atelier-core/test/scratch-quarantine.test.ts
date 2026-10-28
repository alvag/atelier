import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ProcessReader, sweepStaleScratch } from "../src/scratch.ts";

/** Every rename the sweep makes, and a hook that runs right after one. */
const renames: [string, string][] = [];
let afterRename: ((from: string, to: string) => Promise<void>) | undefined;

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		rename: async (from: string, to: string) => {
			await actual.rename(from, to);
			renames.push([from, to]);
			await afterRename?.(from, to);
		},
	};
});

let root: string;
const DEAD = 4343;
const T = 1_700_000_000_000;
const dead: ProcessReader = { isAlive: () => false, startedAt: async () => undefined };
const TRASH = /^atelier-trash-[A-Za-z0-9]{6}$/;
const SCRATCH = /^atelier-(session|verify|freeze|bash)-[A-Za-z0-9]{6}$/;

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

async function deadScratch(name: string): Promise<string> {
	const dir = join(root, name);
	await mkdir(join(dir, "work"), { recursive: true });
	await writeFile(join(dir, ".atelier-owner"), JSON.stringify({ pid: DEAD, startedAt: T }));
	await writeFile(join(dir, "work", "output.log"), "left behind\n");
	return dir;
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "atelier-quarantine-test-"));
	renames.length = 0;
	afterRename = undefined;
});
afterEach(async () => {
	afterRename = undefined;
	await rm(root, { recursive: true, force: true });
});

describe("the directory a sweep moves aside", () => {
	it("is recognized and deleted by the next sweep when the process dies right after the rename", async () => {
		const dir = await deadScratch("atelier-session-aaaaaa");
		// The sweeping process is gone the moment its rename returns: nothing after it runs.
		afterRename = async () => {
			throw new Error("the process died");
		};
		expect(await sweepStaleScratch({ tmpRoot: root, processes: dead })).toEqual([]);
		const [left] = await readdir(root);
		expect(left).toMatch(TRASH);
		expect(await readFile(join(root, left as string, ".atelier-owner"), "utf8")).toContain(`${DEAD}`);
		expect(await exists(dir)).toBe(false);

		afterRename = undefined;
		expect(await sweepStaleScratch({ tmpRoot: root, processes: dead })).toEqual([join(root, left as string)]);
		expect(await readdir(root)).toEqual([]);
	});

	it("gets a name of its own in each of two concurrent sweeps, which no scratch directory's pattern matches", async () => {
		for (const letter of "abcdefgh") await deadScratch(`atelier-session-${letter.repeat(6)}`);

		await Promise.all([
			sweepStaleScratch({ tmpRoot: root, processes: dead }),
			sweepStaleScratch({ tmpRoot: root, processes: dead }),
		]);

		const trash = renames.map(([, to]) => basename(to)).filter((name) => name.startsWith("atelier-trash-"));
		expect(trash).toHaveLength(8);
		expect(new Set(trash).size).toBe(trash.length);
		for (const name of trash) {
			expect(name).toMatch(TRASH);
			expect(name).not.toMatch(SCRATCH);
		}
		expect(await readdir(root)).toEqual([]);
	});

	it("is not put back over a directory that is not empty and took its name meanwhile", async () => {
		const dir = await deadScratch("atelier-verify-bbbbbb");
		const locked = join(dir, "work", "locked");
		await mkdir(locked);
		await writeFile(join(locked, "file"), "x\n");
		await chmod(locked, 0o500);
		afterRename = async (from) => {
			if (from !== dir) return;
			afterRename = undefined;
			await mkdir(dir);
			await writeFile(join(dir, "newcomer"), "must survive\n");
		};
		try {
			expect(await sweepStaleScratch({ tmpRoot: root, processes: dead })).toEqual([]);
			expect(await readFile(join(dir, "newcomer"), "utf8")).toBe("must survive\n");
			expect(await readdir(dir)).toEqual(["newcomer"]);
			const trash = (await readdir(root)).filter((name) => TRASH.test(name));
			expect(trash).toHaveLength(1);
			expect(await readdir(join(root, trash[0] as string))).toContain(".atelier-owner");
		} finally {
			for (const name of await readdir(root)) await chmod(join(root, name, "work", "locked"), 0o700).catch(() => {});
		}
	});
});
