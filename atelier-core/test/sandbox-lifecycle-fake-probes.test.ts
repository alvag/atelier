import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";
import { removeShortRoots, shortRoot } from "./short-root.ts";

// Registered first, so it runs after the file's own clean-up: nothing a test made is left behind, even when it failed.
afterEach(async () => {
	expect(await removeShortRoots()).toEqual([]);
});

const gate = () => {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { resolve, reject, promise };
};
let original: string | undefined;
let root: string;
const release: (() => Promise<void>)[] = [];
beforeEach(async () => {
	// Only deadlines use the fake clock: filesystem work and manager gates remain real.
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	original = process.env.TMPDIR;
	root = await shortRoot("fake-lifecycle-");
	const long = join(root, "x".repeat(80));
	await mkdir(long);
	process.env.TMPDIR = long;
});
afterEach(async () => {
	try {
		for (const end of release.splice(0)) await end();
	} finally {
		vi.useRealTimers();
		if (original === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = original;
	}
});
function harness(holdStop = false, holdRestarts = false) {
	const began = gate();
	const restarted = gate();
	const end = gate();
	const rest = gate();
	const stopping = gate();
	const stopEnd = gate();
	const stopped = gate();
	if (!holdStop) stopEnd.resolve();
	if (!holdRestarts) rest.resolve();
	let calls = 0;
	let resets = 0;
	let active = 0;
	let maxActive = 0;
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {
			const n = ++calls;
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				if (n === 1) {
					began.resolve();
					await end.promise;
				} else {
					restarted.resolve();
					await rest.promise;
				}
			} finally {
				active--;
			}
		},
		wrapWithSandbox: async (command) => command,
		cleanupAfterCommand: () => {},
		reset: async () => {
			resets++;
			stopping.resolve();
			await stopEnd.promise;
			stopped.resolve();
		},
	};
	const sandbox = new Sandbox({ platform: "darwin", manager, socketRoot: root, startTimeoutMs: 30 });
	release.push(async () => {
		end.resolve();
		rest.resolve();
		stopEnd.resolve();
		await sandbox.reset();
		if (calls > 0) await stopped.promise;
		// The stop gate settles before the sandbox finishes retiring that initializer.
		await sandbox.reset();
	});
	return {
		sandbox,
		began,
		restarted,
		end,
		rest,
		stopping,
		stopEnd,
		stopped,
		metrics: () => ({ calls, resets, active, maxActive }),
	};
}
async function timeOutStart(h: ReturnType<typeof harness>) {
	const first = h.sandbox.status();
	await h.began.promise;
	await vi.advanceTimersByTimeAsync(30);
	expect(await first).toEqual({ available: false, reason: "the sandbox did not start within 0.03 s", failed: true });
}
it.each(["success", "failure"] as const)(
	"resets a late %s exactly once before another initialization",
	async (outcome) => {
		const h = harness();
		await timeOutStart(h);
		if (outcome === "success") h.end.resolve();
		else h.end.reject(new Error("late failure"));
		await h.stopped.promise;
		expect(h.metrics().resets).toBe(1);
		expect(h.metrics().calls).toBe(1);
		expect((await h.sandbox.status()).available).toBe(false);
		await h.sandbox.reset();
		expect(await h.sandbox.status()).toEqual({ available: true });
		expect(h.metrics().maxActive).toBe(1);
		await h.sandbox.reset();
	},
);
it("bounds the wait for a never-settling abandoned initializer without invoking it twice", async () => {
	const h = harness();
	await timeOutStart(h);
	await h.sandbox.reset();
	let done = false;
	const retry = h.sandbox.status().then((status) => {
		done = true;
		return status;
	});
	await vi.advanceTimersByTimeAsync(29);
	expect(done).toBe(false);
	expect(h.metrics().calls).toBe(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(await retry).toEqual({
		available: false,
		reason: "an earlier start of the sandbox has not finished",
		failed: true,
	});
	expect(h.metrics().calls).toBe(1);
	h.end.resolve();
	await h.stopped.promise;
	await h.sandbox.reset();
	expect(await h.sandbox.status()).toEqual({ available: true });
	expect(h.metrics().calls).toBe(2);
	await h.sandbox.reset();
});
it("waits for the stop after the abandoned initializer itself settled", async () => {
	const h = harness(true);
	await timeOutStart(h);
	h.end.resolve();
	await h.stopping.promise;
	let done = false;
	const reset = h.sandbox.reset().then(() => {
		done = true;
	});
	await vi.advanceTimersByTimeAsync(29);
	expect(done).toBe(false);
	h.stopEnd.resolve();
	await reset;
	expect(h.metrics().resets).toBe(1);
});
it("waits for abandoned initializer cleanup before initializing again", async () => {
	const h = harness(true, true);
	await timeOutStart(h);
	await h.sandbox.reset();
	const retry = h.sandbox.status();
	h.end.resolve();
	await h.stopping.promise;
	await vi.advanceTimersByTimeAsync(29);
	expect(h.metrics().calls).toBe(1);
	h.stopEnd.resolve();
	await h.restarted.promise;
	h.rest.resolve();
	expect(await retry).toEqual({ available: true });
	expect(h.metrics().calls).toBe(2);
	expect(h.metrics().maxActive).toBe(1);
	await h.sandbox.reset();
});
it("does not resurrect a reset restart or enter initialize concurrently", async () => {
	const h = harness(false, true);
	await timeOutStart(h);
	await h.sandbox.reset();
	const stale = h.sandbox.status();
	await h.sandbox.reset();
	const current = h.sandbox.status();
	h.end.resolve();
	await h.restarted.promise;
	h.rest.resolve();
	const statuses = await Promise.all([stale, current]);
	const metrics = h.metrics();
	await h.sandbox.reset();
	expect(metrics.maxActive).toBe(1);
	expect(metrics.calls).toBe(2);
	expect(statuses[0]?.available).toBe(false);
	expect(statuses[1]).toEqual({ available: true });
});
