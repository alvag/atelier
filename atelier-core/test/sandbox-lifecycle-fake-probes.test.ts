import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
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
const drain = async () => {
	for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
let original: string | undefined;
let root: string;
const release: (() => void)[] = [];
beforeEach(async () => {
	original = process.env.TMPDIR;
	root = await shortRoot("fake-lifecycle-");
	const long = join(root, "x".repeat(80));
	await mkdir(long);
	process.env.TMPDIR = long;
});
afterEach(async () => {
	for (const end of release.splice(0)) end();
	await drain();
	if (original === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = original;
});
function harness(holdStop = false, holdRestarts = false) {
	const began = gate();
	const end = gate();
	const rest = gate();
	const stopping = gate();
	const stopEnd = gate();
	const stopped = gate();
	release.push(end.resolve, rest.resolve, stopEnd.resolve);
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
				} else await rest.promise;
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
	return {
		sandbox,
		began,
		end,
		rest,
		stopping,
		stopEnd,
		stopped,
		metrics: () => ({ calls, resets, active, maxActive }),
	};
}
it.each(["success", "failure"] as const)(
	"resets a late %s exactly once before another initialization",
	async (outcome) => {
		const h = harness();
		const first = h.sandbox.status();
		await h.began.promise;
		expect((await first).available).toBe(false);
		if (outcome === "success") h.end.resolve();
		else h.end.reject(new Error("late failure"));
		await h.stopped.promise;
		await drain();
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
	const first = h.sandbox.status();
	await h.began.promise;
	await first;
	await h.sandbox.reset();
	expect(await h.sandbox.status()).toEqual({
		available: false,
		reason: "an earlier start of the sandbox has not finished",
		failed: true,
	});
	expect(h.metrics().calls).toBe(1);
	h.end.resolve();
	await h.stopped.promise;
	await drain();
	await h.sandbox.reset();
	expect(await h.sandbox.status()).toEqual({ available: true });
	expect(h.metrics().calls).toBe(2);
	await h.sandbox.reset();
});
it("waits for the stop after the abandoned initializer itself settled", async () => {
	const h = harness(true);
	const first = h.sandbox.status();
	await h.began.promise;
	await first;
	h.end.resolve();
	await h.stopping.promise;
	let done = false;
	const reset = h.sandbox.reset().then(() => {
		done = true;
	});
	await drain();
	expect(done).toBe(false);
	h.stopEnd.resolve();
	await reset;
	expect(h.metrics().resets).toBe(1);
});
it("does not resurrect a reset restart or enter initialize concurrently", async () => {
	const h = harness(false, true);
	const first = h.sandbox.status();
	await h.began.promise;
	await first;
	await h.sandbox.reset();
	const stale = h.sandbox.status();
	await drain();
	await h.sandbox.reset();
	const current = h.sandbox.status();
	await drain();
	h.end.resolve();
	await h.stopped.promise;
	await drain();
	const metrics = h.metrics();
	h.rest.resolve();
	const statuses = await Promise.all([stale, current]);
	await h.sandbox.reset();
	expect(metrics.maxActive).toBe(1);
	expect(metrics.calls).toBe(2);
	expect(statuses[0]?.available).toBe(false);
});
