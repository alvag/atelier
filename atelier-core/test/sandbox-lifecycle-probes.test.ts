import { mkdir, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager as runtime } from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, expect, it } from "vitest";
import { isInsideSandbox, Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";
import { removeShortRoots, shortRoot } from "./short-root.ts";

// Registered first, so it runs after the file's own clean-up: nothing a test made is left behind, even when it failed.
afterEach(async () => {
	expect(await removeShortRoots()).toEqual([]);
});

const deferred = () => {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};
const drain = async () => {
	for (let n = 0; n < 50; n++) await new Promise<void>((resolve) => setImmediate(resolve));
};
let root: string;
let long: string;
let previous: string | undefined;
let realTmpdir: typeof tmpdir;
beforeEach(async () => {
	previous = process.env.TMPDIR;
	realTmpdir = tmpdir;
	root = await shortRoot("lifecycle-");
	long = join(root, "x".repeat(80));
	await mkdir(long);
	process.env.TMPDIR = long;
	await runtime.reset();
});
afterEach(async () => {
	await runtime.reset();
	if (previous === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = previous;
});
const realIt = it.skipIf(process.platform !== "darwin" || isInsideSandbox());
function harness(options: { holdStop?: boolean; holdRestarts?: boolean } = {}) {
	const gates = [deferred(), deferred(), deferred()];
	const entered = [deferred(), deferred(), deferred()];
	const finished = [deferred(), deferred(), deferred()];
	const stopping = deferred();
	const stopGate = deferred();
	const stopped = deferred();
	if (!options.holdStop) stopGate.resolve();
	if (!options.holdRestarts) {
		gates[1]?.resolve();
		gates[2]?.resolve();
	}
	let calls = 0;
	let active = 0;
	let maxActive = 0;
	let resets = 0;
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => runtime.isSupportedPlatform(),
		checkDependencies: () => runtime.checkDependencies(),
		initialize: async (config, callback) => {
			const index = calls++;
			active++;
			maxActive = Math.max(maxActive, active);
			try {
				await runtime.initialize(config, callback, false);
				entered[index]?.resolve();
				await gates[index]?.promise;
			} finally {
				active--;
				finished[index]?.resolve();
			}
		},
		wrapWithSandbox: (...args) => runtime.wrapWithSandbox(...args),
		cleanupAfterCommand: () => runtime.cleanupAfterCommand(),
		reset: async () => {
			resets++;
			stopping.resolve();
			await stopGate.promise;
			await runtime.reset();
			stopped.resolve();
		},
	};
	const sandbox = new Sandbox({ platform: "darwin", manager, socketRoot: root, startTimeoutMs: 200 });
	const short = join(root, `atelier-${process.getuid?.() ?? 0}`);
	return {
		sandbox,
		short,
		gates,
		entered,
		finished,
		stopping,
		stopGate,
		stopped,
		metrics: () => ({ calls, active, maxActive, resets }),
	};
}
async function alive(path: string): Promise<boolean> {
	const client = createConnection(path);
	try {
		return await new Promise<boolean>((resolve) => {
			client.once("connect", () => resolve(true));
			client.once("error", () => resolve(false));
		});
	} finally {
		client.destroy();
	}
}
async function assertStopped(short: string, oldSocket: string) {
	expect(runtime.getProxyPort()).toBeUndefined();
	expect(await readdir(short)).toEqual([]);
	expect(await alive(oldSocket)).toBe(false);
	expect(tmpdir).toBe(realTmpdir);
	expect(tmpdir()).toBe(long);
	expect(process.env.TMPDIR).toBe(long);
}
realIt.each([
	["success", "before"],
	["failure", "before"],
	["success", "after"],
	["failure", "after"],
] as const)("deadline then late %s, reset %s settlement, and subsequent status", async (outcome, resetWhen) => {
	const h = harness();
	const ready = h.sandbox.status();
	await h.entered[0]?.promise;
	const name = (await readdir(h.short)).find((item) => item.startsWith("srt-mux-"));
	if (!name) throw new Error("no real socket");
	const socket = join(h.short, name);
	expect(await alive(socket)).toBe(true);
	expect(await ready).toEqual({ available: false, reason: "the sandbox did not start within 0.2 s", failed: true });
	if (resetWhen === "before") await h.sandbox.reset();
	if (outcome === "success") h.gates[0]?.resolve();
	else h.gates[0]?.reject(new Error("late failure"));
	await h.stopped.promise;
	await drain();
	if (resetWhen === "after") {
		expect(await h.sandbox.status()).toEqual({
			available: false,
			reason: "the sandbox did not start within 0.2 s",
			failed: true,
		});
		await h.sandbox.reset();
	}
	expect(h.metrics().resets).toBe(1);
	await assertStopped(h.short, socket);
	expect(await h.sandbox.status()).toEqual({ available: true });
	expect(h.metrics().calls).toBe(2);
	expect(h.metrics().maxActive).toBe(1);
	await h.sandbox.reset();
	await assertStopped(h.short, socket);
});
realIt.each(["success", "failure"] as const)(
	"reset aborts an unsettled real start, which later reports %s",
	async (outcome) => {
		const h = harness();
		const ready = h.sandbox.status();
		await h.entered[0]?.promise;
		const name = (await readdir(h.short)).find((item) => item.startsWith("srt-mux-"));
		if (!name) throw new Error("no socket");
		const socket = join(h.short, name);
		await h.sandbox.reset();
		expect(await ready).toEqual({
			available: false,
			reason: "the sandbox was reset while it was starting",
			failed: true,
		});
		if (outcome === "success") h.gates[0]?.resolve();
		else h.gates[0]?.reject(new Error("late failure"));
		await h.stopped.promise;
		await drain();
		expect(h.metrics().resets).toBe(1);
		await assertStopped(h.short, socket);
		expect(await h.sandbox.status()).toEqual({ available: true });
		expect(h.metrics().calls).toBe(2);
		await h.sandbox.reset();
	},
);
realIt("a new start has a bounded wait for an abandoned initializer and never initializes in parallel", async () => {
	const h = harness();
	const ready = h.sandbox.status();
	await h.entered[0]?.promise;
	await ready;
	await h.sandbox.reset();
	const before = Date.now();
	const retry = h.sandbox.status();
	await drain();
	expect(h.metrics().calls).toBe(1);
	expect(await retry).toEqual({
		available: false,
		reason: "an earlier start of the sandbox has not finished",
		failed: true,
	});
	expect(Date.now() - before).toBeLessThan(1500);
	expect(h.metrics().calls).toBe(1);
	h.gates[0]?.resolve();
	await h.stopped.promise;
	await drain();
	expect(await h.sandbox.status()).toEqual({
		available: false,
		reason: "an earlier start of the sandbox has not finished",
		failed: true,
	});
	await h.sandbox.reset();
	expect(await h.sandbox.status()).toEqual({ available: true });
	expect(h.metrics().maxActive).toBe(1);
	await h.sandbox.reset();
});
realIt("one new start waits for abandoned cleanup before initializing", async () => {
	const h = harness();
	const ready = h.sandbox.status();
	await h.entered[0]?.promise;
	await ready;
	await h.sandbox.reset();
	const retry = h.sandbox.status();
	await drain();
	expect(h.metrics().calls).toBe(1);
	h.gates[0]?.resolve();
	await h.stopped.promise;
	expect(await retry).toEqual({ available: true });
	expect(h.metrics().calls).toBe(2);
	expect(h.metrics().maxActive).toBe(1);
	await h.sandbox.reset();
});
realIt("reset after settlement waits for the abandoned manager's stop", async () => {
	const h = harness({ holdStop: true });
	const ready = h.sandbox.status();
	await h.entered[0]?.promise;
	await ready;
	h.gates[0]?.resolve();
	await h.stopping.promise;
	let done = false;
	const reset = h.sandbox.reset().then(() => {
		done = true;
	});
	await drain();
	expect(done).toBe(false);
	h.stopGate.resolve();
	await reset;
	expect(runtime.getProxyPort()).toBeUndefined();
	expect(h.metrics().resets).toBe(1);
	expect(await h.sandbox.status()).toEqual({ available: true });
	await h.sandbox.reset();
});
realIt("reset cancels a restart waiting for abandoned cleanup, without a stale or parallel initializer", async () => {
	const h = harness({ holdRestarts: true });
	const ready = h.sandbox.status();
	await h.entered[0]?.promise;
	await ready;
	await h.sandbox.reset();
	const stale = h.sandbox.status();
	await drain();
	expect(h.metrics().calls).toBe(1);
	await h.sandbox.reset();
	const current = h.sandbox.status();
	await drain();
	expect(h.metrics().calls).toBe(1);
	h.gates[0]?.resolve();
	await h.stopped.promise;
	await drain();
	const metrics = h.metrics();
	h.gates[1]?.resolve();
	h.gates[2]?.resolve();
	const statuses = await Promise.all([stale, current]);
	console.log("restart/reset race", { metrics, statuses });
	await h.sandbox.reset();
	expect(metrics.maxActive).toBe(1);
	expect(metrics.calls).toBe(2);
	expect(statuses[0]?.available).toBe(false);
	expect(await h.sandbox.status()).toEqual({ available: true });
	await h.sandbox.reset();
});
