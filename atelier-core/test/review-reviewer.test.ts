import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ZERO_USAGE } from "../src/events.ts";
import { freezeCandidate } from "../src/review/candidate.ts";
import type { Finding } from "../src/review/findings.ts";
import type { Receipt } from "../src/review/receipts.ts";
import {
	correctionBudget,
	type ReviewDeps,
	type ReviewProgress,
	type RoleResult,
	runReview,
} from "../src/review/reviewer.ts";
import { assessRisk, type Lens } from "../src/review/risk.ts";
import { parseResults, parseVerdicts } from "../src/review/roles.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const lines = (count: number, tag = "x") => `${Array.from({ length: count }, (_, i) => `${tag}${i}`).join("\n")}\n`;

/** A repo with one committed file and `changed` added lines in the worktree. */
async function setup(changed: number) {
	const root = await mkdtemp(join(tmpdir(), "atelier-reviewer-test-"));
	dirs.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
	git("init", "-q");
	await writeFile(join(root, "a.ts"), "base\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	await writeFile(join(root, "a.ts"), `base\n${lines(changed)}`);
	const frozen = await freezeCandidate(root);
	if (!frozen.ok) throw new Error(frozen.reason);
	return { root, candidate: frozen.candidate, assessment: assessRisk(frozen.candidate, { lens: "reliability" }) };
}

const usage = (n = 1) => ({ input: n, output: n, cacheRead: 0, cacheWrite: 0 });
const finding = (over: Partial<Finding> = {}): Finding => ({
	id: "x",
	lens: "reliability",
	severity: "critical",
	cause: "candidate",
	path: "a.ts",
	line: 2,
	claim: "Drops the token.",
	evidence: "a.ts:2",
	...over,
});
const report = (...found: Finding[]) => JSON.stringify({ findings: found });
const ok = (text: string, over: Partial<RoleResult & { ok: true }> = {}): RoleResult => ({
	ok: true,
	text,
	usage: usage(),
	...over,
});

type RoleCall = Parameters<ReviewDeps["runRole"]>[0];

interface Script {
	lens?: (call: RoleCall, n: number) => RoleResult;
	refuter?: (call: RoleCall) => RoleResult;
	validator?: (call: RoleCall) => RoleResult;
	/** What the main agent does to the worktree when asked to correct. */
	correct?: (message: string, root: string) => Promise<{ ok: boolean }>;
}

function harness(env: Awaited<ReturnType<typeof setup>>, script: Script) {
	const calls: RoleCall[] = [];
	const corrections: string[] = [];
	const lensCalls = new Map<Lens, number>();
	const deps: ReviewDeps = {
		async runRole(call) {
			calls.push(call);
			if (call.role === "refuter") return script.refuter?.(call) ?? ok(JSON.stringify({ verdicts: [] }));
			if (call.role === "validator") return script.validator?.(call) ?? ok(JSON.stringify({ results: [] }));
			const n = (lensCalls.get(call.role) ?? 0) + 1;
			lensCalls.set(call.role, n);
			return script.lens?.(call, n) ?? ok(report());
		},
		async correct(message) {
			corrections.push(message);
			const done = (await script.correct?.(message, env.root)) ?? { ok: true };
			return { ...done, usage: usage(10), costUsd: 0.25 };
		},
		freeze: () => freezeCandidate(env.root),
		now: () => new Date("2026-10-22T10:00:00.000Z"),
		createId: () => "rev-1",
	};
	return { deps, calls, corrections };
}

async function drive(env: Awaited<ReturnType<typeof setup>>, deps: ReviewDeps, signal?: AbortSignal) {
	const events: ReviewProgress[] = [];
	const run = runReview({ candidate: env.candidate, assessment: env.assessment, ...(signal ? { signal } : {}) }, deps);
	for (;;) {
		const next = await run.next();
		if (next.done) return { receipt: next.value as Receipt, events };
		events.push(next.value);
	}
}

const verdicts = (...v: { id: string; verdict: "confirmed" | "refuted"; reason?: string }[]) =>
	JSON.stringify({ verdicts: v.map((x) => ({ reason: "because", ...x })) });
const results = (...r: { id: string; resolved: boolean }[]) =>
	JSON.stringify({ results: r.map((x) => ({ evidence: "a.ts:2", ...x })) });
const severeLens = (over: Partial<Finding> = {}) => ({
	lens: (_call: RoleCall, n: number) => (n === 1 ? ok(report(finding(over))) : ok(report())),
});
/** Rewrites the first `count` of the 20 added lines: `2 * count` changed lines. */
const tweak = (count: number) => async (_m: string, root: string) => {
	const rest = lines(20).split("\n").slice(count).join("\n");
	await writeFile(join(root, "a.ts"), `base\n${lines(count, "y")}${rest}`);
	return { ok: true };
};
const edit = (lineCount: number) => async (_m: string, root: string) => {
	await writeFile(join(root, "a.ts"), `base\n${lines(lineCount, "y")}`);
	return { ok: true };
};

describe("correctionBudget", () => {
	it("is min(200, ceil(n/2)) with a floor of 2", () => {
		expect(correctionBudget(0)).toBe(2);
		expect(correctionBudget(3)).toBe(2);
		expect(correctionBudget(5)).toBe(3);
		expect(correctionBudget(20)).toBe(10);
		expect(correctionBudget(399)).toBe(200);
		expect(correctionBudget(10_000)).toBe(200);
	});
});

describe("role parsers", () => {
	it("reads verdicts and results from fenced or bare json", () => {
		expect(parseVerdicts(`\`\`\`json\n${verdicts({ id: "RL-001", verdict: "refuted" })}\n\`\`\``)).toEqual({
			ok: true,
			verdicts: [{ id: "RL-001", verdict: "refuted", reason: "because" }],
		});
		expect(parseResults(results({ id: "RL-001", resolved: true }))).toMatchObject({ ok: true });
	});

	it("rejects text that is not json and the wrong shape", () => {
		expect(parseVerdicts("fine")).toMatchObject({ ok: false });
		expect(parseVerdicts(JSON.stringify({ verdicts: [{ id: "x", verdict: "maybe", reason: "r" }] }))).toMatchObject({
			ok: false,
		});
		expect(parseResults(JSON.stringify({ results: [{ id: "x", resolved: "yes" }] }))).toMatchObject({ ok: false });
		expect(parseResults("{ nope")).toMatchObject({ ok: false });
	});
});

describe("runReview", () => {
	it("approves a clean candidate with the four lenses of a high-risk review and no refuter", async () => {
		const env = await setup(4);
		env.assessment = { ...env.assessment, level: "high", lenses: ["risk", "resilience", "readability", "reliability"] };
		const { deps, calls, corrections } = harness(env, {});
		const { receipt, events } = await drive(env, deps);
		expect(receipt).toMatchObject({
			schema: "atelier.review-receipt/v1",
			id: "rev-1",
			createdAt: "2026-10-22T10:00:00.000Z",
			base: env.candidate.base,
			candidate: env.candidate.tree,
			corrected: null,
			correction: null,
			verdict: "approved",
			lenses: ["risk", "resilience", "readability", "reliability"],
			findings: [],
			refuted: [],
			followUps: [],
		});
		expect(calls.map((c) => c.role).sort()).toEqual(["readability", "reliability", "resilience", "risk"]);
		expect(calls.every((c) => c.tree === env.candidate.tree && c.prompt.includes("Patch:"))).toBe(true);
		expect(corrections).toHaveLength(0);
		expect(events.filter((e) => e.type === "lens_started")).toHaveLength(4);
		expect(events.filter((e) => e.type === "lens_finished")).toHaveLength(4);
	});

	it("approves a passive candidate without calling any model", async () => {
		const env = await setup(4);
		env.assessment = { ...env.assessment, level: "passive", lenses: [] };
		const { deps, calls } = harness(env, {});
		const { receipt } = await drive(env, deps);
		expect(receipt.verdict).toBe("approved");
		expect(receipt.lenses).toEqual([]);
		expect(calls).toHaveLength(0);
	});

	it("approves when the refuter refutes the only severe finding, and keeps it in refuted", async () => {
		const env = await setup(4);
		const { deps, calls, corrections } = harness(env, {
			...severeLens(),
			refuter: () => ok(verdicts({ id: "RL-001", verdict: "refuted", reason: "guarded on line 1" })),
		});
		const { receipt, events } = await drive(env, deps);
		expect(receipt.verdict).toBe("approved");
		expect(receipt.findings).toEqual([]);
		expect(receipt.refuted).toMatchObject([{ id: "RL-001", reason: "guarded on line 1" }]);
		expect(calls.filter((c) => c.role === "refuter")).toHaveLength(1);
		expect(corrections).toHaveLength(0);
		expect(events.some((e) => e.type === "refuter_finished")).toBe(true);
	});

	it("sends all severe findings to one refuter call, unknown cause included", async () => {
		const env = await setup(4);
		const { deps, calls } = harness(env, {
			lens: (_c, n) =>
				n === 1
					? ok(
							report(
								finding(),
								finding({ cause: "unknown", severity: "blocker", claim: "Maybe" }),
								finding({ severity: "major" }),
							),
						)
					: ok(report()),
			refuter: () => ok(verdicts({ id: "RL-001", verdict: "refuted" }, { id: "RL-002", verdict: "refuted" })),
		});
		const { receipt } = await drive(env, deps);
		const refuterCalls = calls.filter((c) => c.role === "refuter");
		expect(refuterCalls).toHaveLength(1);
		expect(refuterCalls[0]?.prompt).toContain("RL-001");
		expect(refuterCalls[0]?.prompt).toContain("RL-002");
		expect(refuterCalls[0]?.prompt).not.toContain("RL-003");
		expect(receipt.followUps.map((f) => f.id)).toEqual(["RL-003"]);
		expect(receipt.refuted.map((f) => f.id)).toEqual(["RL-001", "RL-002"]);
	});

	it("puts pre-existing and non-severe findings in followUps without a refuter or correction", async () => {
		const env = await setup(4);
		const { deps, calls, corrections } = harness(env, {
			lens: () =>
				ok(
					report(
						finding({ cause: "pre-existing", severity: "blocker" }),
						finding({ severity: "minor", cause: "unknown" }),
					),
				),
		});
		const { receipt } = await drive(env, deps);
		expect(receipt.verdict).toBe("approved");
		expect(receipt.followUps).toHaveLength(2);
		expect(receipt.findings).toEqual([]);
		expect(calls.map((c) => c.role)).toEqual(["reliability"]);
		expect(corrections).toHaveLength(0);
	});

	it("treats a severe finding the refuter does not mention as confirmed", async () => {
		const env = await setup(20);
		const { deps, corrections } = harness(env, {
			...severeLens(),
			refuter: () => ok(verdicts()),
			correct: tweak(2),
			validator: () => ok(results({ id: "RL-001", resolved: true })),
		});
		const { receipt } = await drive(env, deps);
		expect(corrections).toHaveLength(1);
		expect(receipt.findings.map((f) => f.id)).toEqual(["RL-001"]);
	});

	it("corrects once within the budget, validates the corrected tree and approves", async () => {
		const env = await setup(20);
		const { deps, calls, corrections } = harness(env, {
			...severeLens(),
			refuter: () => ok(verdicts({ id: "RL-001", verdict: "confirmed" })),
			correct: tweak(3),
			validator: () => ok(results({ id: "RL-001", resolved: true })),
		});
		const { receipt, events } = await drive(env, deps);
		expect(corrections).toHaveLength(1);
		expect(corrections[0]).toContain("RL-001");
		expect(corrections[0]).toContain("a.ts:2");
		expect(corrections[0]).toContain("Drops the token.");
		expect(corrections[0]).toContain("10 lines");
		expect(receipt.verdict).toBe("approved");
		expect(receipt.correction).toEqual({ budget: 10, used: 6 });
		expect(receipt.corrected).not.toBeNull();
		expect(receipt.corrected).not.toBe(env.candidate.tree);
		const validator = calls.filter((c) => c.role === "validator");
		expect(validator).toHaveLength(1);
		expect(validator[0]?.tree).toBe(receipt.corrected);
		expect(events.map((e) => e.type)).toEqual(
			expect.arrayContaining(["correction_started", "correction_finished", "validator_started", "validator_finished"]),
		);
	});

	it("escalates when the validator leaves a finding unresolved or does not mention it", async () => {
		for (const reply of [results({ id: "RL-001", resolved: false }), results()]) {
			const env = await setup(20);
			const { deps, calls, corrections } = harness(env, {
				...severeLens(),
				refuter: () => ok(verdicts()),
				correct: tweak(2),
				validator: () => ok(reply),
			});
			const { receipt } = await drive(env, deps);
			expect(receipt.verdict).toBe("escalated");
			expect(receipt.escalatedReason).toContain("RL-001");
			expect(corrections).toHaveLength(1);
			expect(calls.filter((c) => c.role === "validator")).toHaveLength(1);
			expect(calls.filter((c) => c.role === "refuter")).toHaveLength(1);
		}
	});

	it("escalates a correction over the budget without a validator or second correction", async () => {
		const env = await setup(4);
		const { deps, calls, corrections } = harness(env, {
			...severeLens(),
			refuter: () => ok(verdicts()),
			correct: edit(30),
		});
		const { receipt } = await drive(env, deps);
		expect(receipt.verdict).toBe("escalated");
		expect(receipt.escalatedReason).toContain("budget");
		expect(receipt.correction?.budget).toBe(2);
		expect(receipt.correction?.used).toBeGreaterThan(2);
		expect(calls.some((c) => c.role === "validator")).toBe(false);
		expect(corrections).toHaveLength(1);
	});

	it("escalates a binary correction as over budget", async () => {
		const env = await setup(20);
		const { deps, calls } = harness(env, {
			...severeLens(),
			refuter: () => ok(verdicts()),
			correct: async (_m, root) => {
				await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 2, 3, 0]));
				return { ok: true };
			},
		});
		const { receipt } = await drive(env, deps);
		expect(receipt.verdict).toBe("escalated");
		expect(receipt.correction?.used).toBeGreaterThan(receipt.correction?.budget ?? 0);
		expect(calls.some((c) => c.role === "validator")).toBe(false);
	});

	it("escalates when the correction fails, and when the re-freeze fails", async () => {
		const failed = await setup(20);
		const first = harness(failed, {
			...severeLens(),
			refuter: () => ok(verdicts()),
			correct: async () => ({ ok: false }),
		});
		const a = await drive(failed, first.deps);
		expect(a.receipt.verdict).toBe("escalated");
		expect(a.receipt.escalatedReason).toContain("correction");
		expect(a.receipt.corrected).toBeNull();

		const frozen = await setup(20);
		const second = harness(frozen, { ...severeLens(), refuter: () => ok(verdicts()), correct: tweak(2) });
		second.deps.freeze = async () => ({ ok: false, reason: "no git" });
		const b = await drive(frozen, second.deps);
		expect(b.receipt.verdict).toBe("escalated");
		expect(b.receipt.escalatedReason).toContain("no git");
		expect(second.calls.some((c) => c.role === "validator")).toBe(false);
	});

	it("retries a malformed lens once with the parse error appended, then goes on", async () => {
		const env = await setup(4);
		const { deps, calls } = harness(env, { lens: (_c, n) => (n === 1 ? ok("looks fine to me") : ok(report())) });
		const { receipt } = await drive(env, deps);
		expect(receipt.verdict).toBe("approved");
		expect(calls).toHaveLength(2);
		expect(calls[1]?.prompt.startsWith(calls[0]?.prompt ?? "?")).toBe(true);
		expect(calls[1]?.prompt).toContain("JSON");
		expect(receipt.usage.input).toBe(2);
	});

	it("is unavailable, naming the lens, when a lens is malformed twice", async () => {
		const env = await setup(4);
		const { deps, calls } = harness(env, { lens: () => ok("nope") });
		const { receipt } = await drive(env, deps);
		expect(receipt.verdict).toBe("unavailable");
		expect(receipt.unavailableReason).toContain("reliability");
		expect(calls).toHaveLength(2);
	});

	it("is unavailable when a lens call itself fails", async () => {
		const env = await setup(4);
		const { deps } = harness(env, { lens: () => ({ ok: false, error: "rate limited", usage: usage(3) }) });
		const { receipt } = await drive(env, deps);
		expect(receipt.verdict).toBe("unavailable");
		expect(receipt.unavailableReason).toContain("rate limited");
		expect(receipt.usage.input).toBe(3);
	});

	it("is unavailable with lens_context_budget_exceeded and makes no model call when the patch is too big", async () => {
		const env = await setup(4);
		await writeFile(join(env.root, "big.txt"), "x".repeat(210 * 1024));
		const frozen = await freezeCandidate(env.root);
		if (!frozen.ok) throw new Error(frozen.reason);
		env.candidate = frozen.candidate;
		env.assessment = assessRisk(frozen.candidate);
		const { deps, calls } = harness(env, {});
		const { receipt } = await drive(env, deps);
		expect(receipt.verdict).toBe("unavailable");
		expect(receipt.unavailableReason).toBe("lens_context_budget_exceeded");
		expect(calls).toHaveLength(0);
	});

	it("is unavailable when the refuter fails, and never calls it twice", async () => {
		const env = await setup(20);
		const { deps, calls, corrections } = harness(env, {
			...severeLens(),
			refuter: () => ok("who knows"),
		});
		const { receipt } = await drive(env, deps);
		expect(receipt.verdict).toBe("unavailable");
		expect(receipt.unavailableReason).toContain("refuter");
		expect(calls.filter((c) => c.role === "refuter")).toHaveLength(1);
		expect(corrections).toHaveLength(0);
	});

	it("sums usage and cost over every role call and the correction", async () => {
		const env = await setup(20);
		const { deps } = harness(env, {
			lens: (_c, n) => (n === 1 ? ok(report(finding()), { usage: usage(1), costUsd: 0.1 }) : ok(report())),
			refuter: () => ok(verdicts(), { usage: usage(2), costUsd: 0.2 }),
			correct: tweak(2),
			validator: () => ok(results({ id: "RL-001", resolved: true }), { usage: usage(4), costUsd: 0.4 }),
		});
		const { receipt } = await drive(env, deps);
		expect(receipt.usage).toEqual({ input: 17, output: 17, cacheRead: 0, cacheWrite: 0 });
		expect(receipt.costUsd).toBeCloseTo(0.95);
	});

	it("omits costUsd when no call reported one", async () => {
		const env = await setup(4);
		const { deps } = harness(env, {});
		const { receipt } = await drive(env, deps);
		expect(receipt.costUsd).toBeUndefined();
		expect(receipt.usage).not.toEqual(ZERO_USAGE);
	});

	it("is unavailable with reason interrupted when aborted, before or during the cycle", async () => {
		const early = await setup(4);
		const controller = new AbortController();
		controller.abort();
		const first = harness(early, {});
		const a = await drive(early, first.deps, controller.signal);
		expect(a.receipt).toMatchObject({ verdict: "unavailable", unavailableReason: "interrupted" });
		expect(first.calls).toHaveLength(0);

		const env = await setup(20);
		const mid = new AbortController();
		const { deps, calls, corrections } = harness(env, {
			...severeLens(),
			refuter: () => {
				mid.abort();
				return ok(verdicts());
			},
		});
		const b = await drive(env, deps, mid.signal);
		expect(b.receipt).toMatchObject({ verdict: "unavailable", unavailableReason: "interrupted" });
		expect(corrections).toHaveLength(0);
		expect(calls.some((c) => c.role === "validator")).toBe(false);
	});

	it("never touches the user's worktree or index", async () => {
		const env = await setup(20);
		const status = () => execFileSync("git", ["status", "--porcelain"], { cwd: env.root, encoding: "utf8" });
		const before = status();
		const { deps } = harness(env, severeLens({ severity: "minor" }));
		await drive(env, deps);
		expect(status()).toBe(before);
	});

	it.each(["refuter", "validator"] as const)("does not approve contradictory %s results for one id", async (role) => {
		const env = await setup(20);
		const { deps } = harness(env, {
			...severeLens(),
			refuter: () =>
				ok(
					role === "refuter"
						? verdicts({ id: "RL-001", verdict: "refuted" }, { id: "RL-001", verdict: "confirmed" })
						: verdicts(),
				),
			correct: tweak(1),
			validator: () => ok(results({ id: "RL-001", resolved: true }, { id: "RL-001", resolved: false })),
		});
		const { receipt } = await drive(env, deps);
		expect(receipt.verdict).toBe(role === "refuter" ? "unavailable" : "escalated");
	});

	it.each(["correction_started", "freeze"])("starts nothing new after an abort at %s", async (stage) => {
		const env = await setup(20);
		const controller = new AbortController();
		const { deps, calls, corrections } = harness(env, { ...severeLens(), correct: tweak(1) });
		const originalFreeze = deps.freeze;
		if (stage === "freeze")
			deps.freeze = async () => {
				const frozen = await originalFreeze();
				controller.abort();
				return frozen;
			};
		let receipt: Receipt | undefined;
		const run = runReview({ ...env, signal: controller.signal }, deps);
		for (;;) {
			const next = await run.next();
			if (next.done) {
				receipt = next.value;
				break;
			}
			if (next.value.type === stage) controller.abort();
		}
		expect(corrections).toHaveLength(stage === "correction_started" ? 0 : 1);
		expect(calls.some((call) => call.role === "validator")).toBe(false);
		expect(receipt?.verdict).toBe("unavailable");
	});

	it("keeps the severe findings in the receipt when the refuter fails", async () => {
		const env = await setup(20);
		const { deps } = harness(env, {
			...severeLens(),
			refuter: () => ({ ok: false, error: "offline", usage: usage() }),
		});
		const { receipt } = await drive(env, deps);
		expect(receipt.verdict).toBe("unavailable");
		expect([...receipt.findings, ...receipt.refuted, ...receipt.followUps]).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "RL-001", claim: "Drops the token." })]),
		);
	});
});
