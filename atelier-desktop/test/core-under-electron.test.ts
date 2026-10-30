import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canFakePs, sweepingChild, type TrackedChild } from "../../atelier-core/test/support/sweeping-child.ts";

/**
 * The Electron the desktop runs the core with, or undefined when its binary is not installed. Found through its
 * `path.txt`, never `require("electron")`, which downloads a missing binary.
 */
function electronBinary(): string | undefined {
	try {
		const dir = dirname(createRequire(import.meta.url).resolve("electron/package.json"));
		const binary = join(dir, "dist", readFileSync(join(dir, "path.txt"), "utf8").trim());
		return existsSync(binary) ? binary : undefined;
	} catch {
		return undefined;
	}
}

const electron = electronBinary();
let root: string | undefined;
let child: TrackedChild | undefined;

/** Waits for a condition instead of a fixed delay. */
async function until(condition: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

afterEach(async () => {
	child?.stop();
	child = undefined;
	if (root !== undefined) await rm(root, { recursive: true, force: true });
	root = undefined;
});

describe.skipIf(electron === undefined || !canFakePs)("the core on Electron's Node", () => {
	it("sweeps the temporary folder in its worker and ends on its own, without errors", async () => {
		root = await mkdtemp(join(tmpdir(), "atelier-electron-test-"));
		child = await sweepingChild(root, electron as string, { ELECTRON_RUN_AS_NODE: "1" });
		await until(() => child?.exited !== undefined, 12_000);
		expect(child.stderr).toBe("");
		expect(child.stdout).toBe("sweeping\n");
		expect(child.exited).toBe(0);
	}, 20_000);
});
