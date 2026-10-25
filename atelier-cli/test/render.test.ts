import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { describe, expect, it } from "vitest";
import { Renderer } from "../src/render.ts";

function render(bodies: (AtelierEventBody & { parentCallId?: string; agent?: string })[], cwd?: string) {
	let stdout = "";
	let stderr = "";
	const renderer = new Renderer({
		stdout: (s) => (stdout += s),
		stderr: (s) => (stderr += s),
		color: false,
		...(cwd === undefined ? {} : { cwd }),
	});
	for (const [i, body] of bodies.entries()) renderer.render({ ...body, seq: i + 1, turnId: "t" } as AtelierEvent);
	return { stdout, stderr, renderer };
}

const usage = { input: 1200, output: 85, cacheRead: 9000, cacheWrite: 3100 };

describe("Renderer", () => {
	it("streams text, one line per tool and the turn's tokens", () => {
		const { stdout, stderr } = render([
			{ type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "subscription" },
			{ type: "thinking_delta", text: "hmm" },
			{ type: "text_delta", text: "Let me " },
			{ type: "text_delta", text: "look." },
			{ type: "tool_call_started", callId: "c1", tool: "read", input: { path: "src/user.ts" } },
			{ type: "tool_call_finished", callId: "c1", ok: true, summary: "src/user.ts (12 lines)", truncated: false },
			{ type: "tool_call_started", callId: "c2", tool: "bash", input: { command: "npm test" } },
			{ type: "tool_call_finished", callId: "c2", ok: false, summary: "npm test (exit 1)", truncated: true },
			{ type: "text_delta", text: "Fixed." },
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.0421 },
		]);
		expect(stdout).toBe(
			[
				"atelier · claude-code · claude-opus-5-5 · subscription",
				"Let me look.",
				"▸ read src/user.ts (12 lines) ✓",
				"▸ bash npm test (exit 1) ✗ (truncated)",
				"Fixed.",
				"tokens: input 1,200 · output 85 · cache read 9,000 · cache write 3,100 · cache 68% · $0.0421",
				"",
			].join("\n"),
		);
		expect(stderr).toBe("");
	});

	describe("the sandbox", () => {
		it("says on stdout that bash is sandboxed", () => {
			const { stdout, stderr } = render([{ type: "sandbox_status", sandboxed: true, mechanism: "macOS seatbelt" }]);
			expect(stdout).toBe("bash: sandboxed (macOS seatbelt)\n");
			expect(stderr).toBe("");
		});

		it("warns on stderr, with the reason, that bash is not sandboxed", () => {
			const { stdout, stderr } = render([
				{ type: "sandbox_status", sandboxed: false, reason: "sandbox not available on this platform" },
			]);
			expect(stdout).toBe("");
			expect(stderr).toBe(
				"bash: not sandboxed (sandbox not available on this platform): every command asks for approval and --yes does not apply\n",
			);
		});

		it("does not repeat the warning in the turn that already said it, but says it in the next turns", () => {
			let stderr = "";
			const renderer = new Renderer({ stdout: () => {}, stderr: (s) => (stderr += s), color: false });
			const events: [string, AtelierEventBody][] = [
				["t1", { type: "sandbox_status", sandboxed: false, reason: "r" }],
				["t1", { type: "sandbox_warning", reason: "r" }],
				["t2", { type: "sandbox_warning", reason: "r" }],
			];
			for (const [i, [turnId, body]] of events.entries())
				renderer.render({ ...body, seq: i + 1, turnId } as AtelierEvent);
			expect(stderr).toBe(
				[
					"bash: not sandboxed (r): every command asks for approval and --yes does not apply",
					"warning: bash runs without a sandbox (r): every command asks for approval and --yes does not apply",
					"",
				].join("\n"),
			);
		});

		it("lists what the sandbox blocked under the tool line, also for a subagent", () => {
			const { stdout } = render([
				{ type: "tool_call_started", callId: "c1", tool: "bash", input: {} },
				{
					type: "tool_call_finished",
					callId: "c1",
					ok: false,
					summary: "touch /x (exit 1)",
					truncated: false,
					blocked: ["write to /x (not an allowed write path)", "and 2 more"],
				},
				{ type: "tool_call_started", callId: "c2", tool: "bash", input: {}, parentCallId: "p", agent: "worker" },
				{
					type: "tool_call_finished",
					callId: "c2",
					ok: false,
					summary: "cat /k (exit 1)",
					truncated: false,
					blocked: ["read of /k (denied by the sandbox policy)"],
					parentCallId: "p",
					agent: "worker",
				},
			]);
			expect(stdout).toBe(
				[
					"▸ bash touch /x (exit 1) ✗",
					"  sandbox blocked: write to /x (not an allowed write path)",
					"  sandbox blocked: and 2 more",
					"  │ ▸ bash cat /k (exit 1) ✗",
					"  │   sandbox blocked: read of /k (denied by the sandbox policy)",
					"",
				].join("\n"),
			);
		});
	});

	it("warns when the session is not using a subscription", () => {
		const { stderr } = render([{ type: "session_started", backend: "claude-code", model: "m", authSource: "api_key" }]);
		expect(stderr).toBe("warning: not using a Claude subscription (auth: api_key); usage may be billed separately.\n");
	});

	it("does not warn about billing on the anthropic-api backend, which is billed to the API key on purpose", () => {
		const { stderr } = render([
			{ type: "session_started", backend: "anthropic-api", model: "claude-sonnet-5-5", authSource: "api_key" },
		]);
		expect(stderr).toBe("");
	});

	it("shows the requests of a turn and why the cache missed", () => {
		const { stdout, stderr } = render([
			{ type: "cache_miss", reason: "system_changed", missedTokens: 4200 },
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.0421, requests: 3 },
		]);
		expect(stdout).toBe(
			"tokens: input 1,200 · output 85 · cache read 9,000 · cache write 3,100 · cache 68% · 3 requests · $0.0421\n",
		);
		expect(stderr).toBe("cache miss: system_changed (4,200 tokens not read from the cache)\n");
	});

	it("shows the turn's cost by phase on a line under the total, only when the turn had more than one", () => {
		const part = (input: number) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0 });
		const { stdout } = render([
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				costUsd: 0.0421,
				requests: 3,
				phases: {
					main: { usage: part(1000), requests: 1, costUsd: 0.04 },
					verify: { usage: part(150), costUsd: 0.0021 },
					lenses: { usage: part(40), requests: 2 },
					validator: { usage: part(9) },
				},
			},
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				phases: { main: { usage } },
			},
		]);
		expect(stdout).toBe(
			[
				"tokens: input 1,200 · output 85 · cache read 9,000 · cache write 3,100 · cache 68% · 3 requests · $0.0421",
				"phases: main $0.0400 (1 req) · verify $0.0021 · lenses 2 req · validator 10 tokens",
				"tokens: input 1,200 · output 85 · cache read 9,000 · cache write 3,100 · cache 68%",
				"",
			].join("\n"),
		);
	});

	it("indents a subagent's work under a header, without failing the parent's turn", () => {
		const child = (body: Record<string, unknown>) =>
			({ ...body, parentCallId: "c1", agent: "explorer" }) as unknown as AtelierEventBody;
		const { stdout, stderr, renderer } = render([
			{ type: "tool_call_started", callId: "c1", tool: "task", input: { agent: "explorer", prompt: "Find it." } },
			child({ type: "session_started", backend: "claude-code", model: "haiku", authSource: "api_key" }),
			child({ type: "tool_call_started", callId: "r1", tool: "read", input: { path: "a.ts" } }),
			child({ type: "tool_call_finished", callId: "r1", ok: true, summary: "a.ts (3 lines)", truncated: false }),
			// A blank line split across deltas, as streaming often sends it.
			child({ type: "text_delta", text: "Found\n" }),
			child({ type: "text_delta", text: "\nit." }),
			child({ type: "error", code: "x", message: "child hiccup", recoverable: false }),
			child({
				type: "turn_finished",
				stopReason: "error",
				usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0 },
				requests: 2,
			}),
			{ type: "tool_call_finished", callId: "c1", ok: true, summary: "explorer: 9 characters", truncated: false },
		]);
		expect(stdout).toBe(
			[
				"  ↳ explorer · haiku",
				"  │ ▸ read a.ts (3 lines) ✓",
				"  │ Found",
				"  │",
				"  │ it.",
				"  │ tokens: input 40 · output 8 · cache read 0 · cache write 0 · cache 0% · 2 requests",
				"▸ task explorer: 9 characters ✓",
				"",
			].join("\n"),
		);
		expect(stderr).toBe("  │ error: child hiccup\n");
		expect(renderer.failed).toBe(false);
	});

	it("prints the phase when it changes and the feature's progress", () => {
		const { stdout, stderr } = render([
			{ type: "phase_changed", phase: "planning", source: "inferred" },
			{
				type: "feature_changed",
				name: "slug-accents",
				path: "odd/tasks/slug-accents.md",
				title: "Slug accents",
				tasks: [
					{ id: "T1", title: "Transliterate", specs: ["S1"], status: "done", commit: "abc1234" },
					{ id: "T2", title: "Run the tests", specs: ["S1"], status: "in_progress" },
					{ id: "T3", title: "Docs", specs: ["S1"], status: "pending" },
				],
			},
			{ type: "phase_changed", phase: "closing", source: "declared" },
		]);
		expect(stdout).toBe(
			[
				"· planning",
				"◆ Slug accents (odd/tasks/slug-accents.md): 1/3 done · now T2 Run the tests",
				"· closing",
				"",
			].join("\n"),
		);
		expect(stderr).toBe("");
	});

	it("says which memory the session uses, or why it has none", () => {
		const on = render([{ type: "memory_status", available: true, project: "atelier" }]);
		expect(on.stdout).toBe("memory: atelier\n");
		const off = render([
			{ type: "memory_status", available: false, reason: "Engram is not installed (no engram command)." },
		]);
		expect(off.stdout).toBe("");
		expect(off.stderr).toBe("no memory: Engram is not installed (no engram command).\n");
	});

	it("says which instruction files were loaded, and warns about those the cap left out", () => {
		const on = render([{ type: "project_instructions", files: ["/w/AGENTS.md", "/w/p/CLAUDE.md"], dropped: [] }]);
		expect(on.stdout).toBe("instructions: /w/AGENTS.md, /w/p/CLAUDE.md\n");
		expect(on.stderr).toBe("");
		const cut = render([{ type: "project_instructions", files: ["/w/p/AGENTS.md"], dropped: ["/w/AGENTS.md"] }]);
		expect(cut.stdout).toBe("instructions: /w/p/AGENTS.md\n");
		expect(cut.stderr).toBe("instructions over 32 KiB, left out: /w/AGENTS.md\n");
	});

	it("prints errors to stderr and remembers them", () => {
		const { stdout, stderr, renderer } = render([
			{ type: "text_delta", text: "partial" },
			{ type: "error", code: "not_logged_in", message: "Claude Code is not logged in.", recoverable: false },
			{ type: "turn_finished", stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		]);
		expect(stdout).toBe("partial\ntokens: input 0 · output 0 · cache read 0 · cache write 0\n");
		expect(stderr).toBe("error: Claude Code is not logged in.\n");
		expect(renderer.failed).toBe(true);
	});

	it("does not count recoverable errors as a failed turn", () => {
		const { renderer } = render([
			{ type: "error", code: "busy", message: "busy", recoverable: true },
			{ type: "turn_finished", stopReason: "end_turn", usage },
		]);
		expect(renderer.failed).toBe(false);
	});

	it("shows rate limits only when they matter", () => {
		const quiet = render([{ type: "rate_limit", status: "allowed", window: "five_hour" }]);
		expect(quiet.stderr).toBe("");
		const loud = render([{ type: "rate_limit", status: "allowed_warning", window: "five_hour", resetsAt: 1792000000 }]);
		expect(loud.stderr).toMatch(/^rate limit: allowed_warning \(five_hour, resets .+\)\n$/);
	});

	describe("review", () => {
		const finished: Extract<AtelierEventBody, { type: "review_finished" }> = {
			type: "review_finished",
			reviewId: "r1",
			verdict: "approved",
			findings: [],
			refuted: [],
			followUps: [],
			correction: null,
			usage,
		};
		const finding = {
			id: "RL-001",
			lens: "reliability",
			severity: "critical",
			cause: "candidate",
			path: "src/auth.ts",
			line: 12,
			claim: "The token is dropped.",
			evidence: "src/auth.ts:12",
		};

		it("warns when there is no review, like memory", () => {
			const { stdout, stderr } = render([{ type: "review_status", available: false, reason: "not a git repository" }]);
			expect(stdout).toBe("");
			expect(stderr).toBe("no review: not a git repository\n");
		});

		it("shows the risk on one line with its lenses and reasons", () => {
			const { stdout } = render([
				{
					type: "review_assessed",
					tree: "t",
					level: "high",
					reasons: ["path: src/auth.ts (auth)", "dependencies: package.json"],
					files: ["src/auth.ts"],
					changedLines: 9,
					lenses: ["risk", "resilience", "readability", "reliability"],
					reviewDue: true,
				},
				{
					type: "review_assessed",
					tree: "t",
					level: "medium",
					reasons: [],
					files: ["a.ts"],
					changedLines: 1,
					lenses: ["reliability"],
					reviewDue: false,
				},
			]);
			expect(stdout).toBe(
				"◇ review high · 4 lenses (path: src/auth.ts (auth); dependencies: package.json)\n◇ review medium · 1 lens\n",
			);
		});

		it("names the lenses the agent chose and why, and only then", () => {
			const { stdout } = render([
				{
					type: "review_assessed",
					tree: "t",
					level: "high",
					reasons: ["agent: item 4 (events can arrive late)"],
					files: ["a.ts"],
					changedLines: 1,
					lenses: ["resilience", "reliability"],
					lensesReason: "only the event order changes",
					reviewDue: true,
				},
			]);
			expect(stdout).toBe(
				"◇ review high · 2 lenses: resilience, reliability (agent: item 4 (events can arrive late)) · lenses chosen: only the event order changes\n",
			);
		});

		it("shows the content-derived reasons with their place", () => {
			const { stdout } = render([
				{
					type: "review_assessed",
					tree: "t",
					level: "high",
					reasons: [
						"shell_process: src/run.ts:2",
						"dangerous_sink: src/run.ts:5 (eval)",
						"process_scan_limit: src/big.ts",
					],
					files: ["src/run.ts"],
					changedLines: 9,
					lenses: ["risk", "resilience", "readability", "reliability"],
					reviewDue: true,
				},
			]);
			expect(stdout).toBe(
				"◇ review high · 4 lenses (shell_process: src/run.ts:2; dangerous_sink: src/run.ts:5 (eval); process_scan_limit: src/big.ts)\n",
			);
		});

		it("shows a declared none on the risk line, and a missing declaration through its reason", () => {
			const base = { type: "review_assessed" as const, tree: "t", files: ["a.ts"], changedLines: 1, reviewDue: false };
			const { stdout } = render([
				{
					...base,
					level: "medium",
					reasons: ["code change without a high-risk signal"],
					lenses: ["reliability"],
					declaration: { kind: "none", reason: "no shared code" },
				},
				{
					...base,
					level: "medium",
					reasons: ["code change; no risk declaration"],
					lenses: ["reliability"],
					declaration: { kind: "missing" },
				},
			]);
			expect(stdout).toBe(
				"◇ review medium · 1 lens (code change without a high-risk signal) · declared none: no shared code\n◇ review medium · 1 lens (code change; no risk declaration)\n",
			);
		});

		it("says which commit the change is measured from, and why when the base fell back to HEAD", () => {
			const base = {
				type: "review_assessed" as const,
				tree: "t",
				level: "medium" as const,
				reasons: [],
				files: ["a.ts"],
				changedLines: 1,
				lenses: ["reliability"],
				reviewDue: false,
			};
			const { stdout } = render([
				{ ...base, since: "1a2b3c4" },
				{
					...base,
					baseNote: "HEAD no longer descends from 1a2b3c4, where the turn started: the base is the current HEAD",
				},
			]);
			expect(stdout).toBe(
				"◇ review medium · 1 lens · since 1a2b3c4\n◇ review medium · 1 lens · HEAD no longer descends from 1a2b3c4, where the turn started: the base is the current HEAD\n",
			);
		});

		it("leaves the consent question to the prompt", () => {
			const { stdout, stderr } = render([
				{ type: "review_consent_requested", reviewId: "r1", level: "high", reasons: ["x"], lenses: ["risk"] },
			]);
			expect([stdout, stderr]).toEqual(["", ""]);
		});

		it("shows one line per step of the cycle", () => {
			const { stdout } = render([
				{ type: "review_progress", reviewId: "r1", step: { type: "lens_started", lens: "risk" } },
				{
					type: "review_progress",
					reviewId: "r1",
					step: { type: "lens_finished", lens: "risk", ok: true, findings: 2 },
				},
				{
					type: "review_progress",
					reviewId: "r1",
					step: { type: "lens_finished", lens: "risk", ok: false, findings: 0 },
				},
				{ type: "review_progress", reviewId: "r1", step: { type: "refuter_started", findings: 1 } },
				{ type: "review_progress", reviewId: "r1", step: { type: "refuter_finished", confirmed: 1, refuted: 0 } },
				{ type: "review_progress", reviewId: "r1", step: { type: "correction_started", budget: 12, findings: 1 } },
				{ type: "review_progress", reviewId: "r1", step: { type: "correction_finished", ok: true, used: 8 } },
				{ type: "review_progress", reviewId: "r1", step: { type: "correction_finished", ok: false } },
				{ type: "review_progress", reviewId: "r1", step: { type: "validator_started", findings: 1 } },
				{ type: "review_progress", reviewId: "r1", step: { type: "validator_finished", resolved: 1, unresolved: 0 } },
			]);
			expect(stdout).toBe(
				[
					"◇ review: lens risk",
					"◇ review: lens risk done · 2 findings",
					"◇ review: lens risk failed",
					"◇ review: refuting 1 finding",
					"◇ review: 1 confirmed · 0 refuted",
					"◇ review: correcting (budget 12 lines)",
					"◇ review: correction done · 8 lines",
					"◇ review: correction failed",
					"◇ review: validating 1 finding",
					"◇ review: 1 resolved · 0 unresolved",
					"",
				].join("\n"),
			);
		});

		it("nests the lens's own work like a subagent", () => {
			const { stdout } = render([
				{
					type: "session_started",
					backend: "fake",
					model: "m",
					authSource: "subscription",
					parentCallId: "r1",
					agent: "review:risk",
				},
				{ type: "text_delta", text: "looking", parentCallId: "r1", agent: "review:risk" },
			] as never);
			expect(stdout).toBe("  ↳ review:risk · m\n  │ looking");
		});

		it("says approved with the receipt, relative to the working directory", () => {
			const { stdout } = render([{ ...finished, receiptPath: "/repo/.git/atelier/reviews/abc.json" }], "/repo");
			expect(stdout).toBe("✓ review approved · receipt .git/atelier/reviews/abc.json\n");
		});

		it("keeps an absolute receipt path that is outside the working directory", () => {
			const { stdout } = render([{ ...finished, receiptPath: "/elsewhere/r.json" }], "/repo");
			expect(stdout).toBe("✓ review approved · receipt /elsewhere/r.json\n");
		});

		it("counts the correction and the follow-ups of an approved review", () => {
			const { stdout } = render([
				{ ...finished, correction: { budget: 12, used: 8 }, followUps: [finding, finding], receiptPath: "r.json" },
			]);
			expect(stdout).toBe("✓ review approved · corrected 8/12 lines · 2 follow-ups · receipt r.json\n");
		});

		it("says plainly that an over-budget correction stays in the worktree", () => {
			const { stdout } = render([
				{
					...finished,
					verdict: "escalated",
					reason: "The correction changed 30 lines, over the budget of 12.",
					findings: [finding],
					correction: { budget: 12, used: 30 },
					receiptPath: "r.json",
				},
			]);
			expect(stdout).toBe(
				[
					"✗ review escalated: The correction changed 30 lines, over the budget of 12. — the correction is left in your worktree, review it before committing",
					"  RL-001 critical src/auth.ts:12 — The token is dropped.",
					"  receipt r.json",
					"",
				].join("\n"),
			);
		});

		it("does not claim a correction when none was applied", () => {
			const { stdout } = render([
				{ ...finished, verdict: "escalated", reason: "Unresolved.", findings: [finding], correction: null },
			]);
			expect(stdout).not.toContain("left in your worktree");
			expect(stdout).toContain("✗ review escalated: Unresolved.\n");
		});

		it("says declined and unavailable", () => {
			const { stdout } = render([
				{ ...finished, verdict: "declined" },
				{ ...finished, verdict: "unavailable", reason: "lens_context_budget_exceeded" },
			]);
			expect(stdout).toBe("◇ review declined\n◇ review unavailable: lens_context_budget_exceeded\n");
		});

		it("shows the cause and the value observed instead of the reason", () => {
			const { stdout } = render([
				{
					...finished,
					verdict: "unavailable",
					reason: "lens_context_budget_exceeded",
					cause: "context_too_large",
					observed: "215000 bytes, limit 204800",
				},
				{
					...finished,
					verdict: "escalated",
					reason: "The correction changed 30 lines, over the budget of 12.",
					cause: "over_budget",
					observed: "30 lines, budget 12",
				},
			]);
			expect(stdout).toBe(
				[
					"◇ review unavailable: context_too_large (215000 bytes, limit 204800)",
					"✗ review escalated: over_budget (30 lines, budget 12)",
					"",
				].join("\n"),
			);
		});
	});

	describe("compaction", () => {
		const started: AtelierEventBody = { type: "compaction_started", reason: "threshold", tokens: 180_000 };
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

		it("shows the compaction, how much the context went down, what was kept and its cost", () => {
			const { stdout, stderr } = render([
				started,
				{
					type: "compaction_finished",
					ok: true,
					reason: "threshold",
					tokensBefore: 180_000,
					tokensAfter: 30_000,
					kept: 3,
					usage: zero,
					costUsd: 0.012,
				},
			]);
			expect(stdout).toBe(
				"◇ compacting context (threshold, 180,000 tokens)\n◇ context compacted: 180,000 → 30,000 tokens · 3 messages kept · $0.0120\n",
			);
			expect(stderr).toBe("");
		});

		it("leaves out what Claude Code does not report", () => {
			const { stdout } = render([
				{ type: "compaction_finished", ok: true, reason: "manual", tokensBefore: 90_000, kept: 0, usage: zero },
			]);
			expect(stdout).toBe("◇ context compacted: 90,000 tokens before\n");
		});

		it("warns when a compaction fails", () => {
			const { stdout, stderr } = render([
				{
					type: "compaction_finished",
					ok: false,
					reason: "manual",
					tokensBefore: 900,
					kept: 0,
					usage: zero,
					error: "There is not enough history to compact.",
				},
			]);
			expect(stdout).toBe("");
			expect(stderr).toBe("compaction failed: There is not enough history to compact.\n");
		});

		it("shows the first cache miss after a compaction as expected, and later ones as warnings", () => {
			const miss: AtelierEventBody = { type: "cache_miss", reason: "messages_changed", missedTokens: 5000 };
			const { stdout, stderr } = render([
				{ type: "compaction_finished", ok: true, reason: "threshold", tokensBefore: 9000, kept: 1, usage: zero },
				miss,
				miss,
			]);
			expect(stdout).toContain("cache miss after compaction: messages_changed (expected)\n");
			expect(stderr).toBe("cache miss: messages_changed (5,000 tokens not read from the cache)\n");
		});

		it("expects the miss only in the compaction's turn and the next one", () => {
			const miss: AtelierEventBody = { type: "cache_miss", reason: "messages_changed", missedTokens: 5000 };
			const turn: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
			const compacted: AtelierEventBody = {
				type: "compaction_finished",
				ok: true,
				reason: "manual",
				tokensBefore: 9000,
				kept: 1,
				usage: zero,
			};
			expect(render([compacted, turn, miss]).stderr).toBe("");
			expect(render([compacted, turn, turn, miss]).stderr).toBe(
				"cache miss: messages_changed (5,000 tokens not read from the cache)\n",
			);
		});

		it("adds how full the context is to the tokens line", () => {
			const { stdout } = render([
				{
					type: "turn_finished",
					stopReason: "end_turn",
					usage,
					context: { tokens: 45_000, window: 200_000, compactAt: 167_616 },
				},
			]);
			expect(stdout).toContain(" · context 45,000 / 200,000 (23%)\n");
		});
	});

	describe("verification", () => {
		const defect = (over: Record<string, unknown> = {}) => ({
			id: "D1",
			severity: "blocker" as const,
			summary: "A pasted y approves the command",
			reproduction: "printf 'ls\\ny' | node cli.ts",
			candidate: "ran ls",
			base: "asked again",
			onBase: false,
			...over,
		});
		const requirement = (verdict: "met" | "unmet" | "unverified", id = "R1") => ({
			id,
			requirement: "approval needs a keypress",
			verdict,
			evidence: "ran it",
		});
		const round = (over: Record<string, unknown> = {}): AtelierEventBody =>
			({
				type: "verification_round",
				verifyId: "v1",
				round: 1,
				ok: true,
				requirements: [],
				defects: [],
				blocking: [],
				correcting: false,
				usage,
				...over,
			}) as AtelierEventBody;
		const done = (over: Record<string, unknown> = {}): AtelierEventBody =>
			({
				type: "verification_finished",
				verifyId: "v1",
				outcome: "passed",
				rounds: 1,
				openDefects: [],
				usage,
				...over,
			}) as AtelierEventBody;

		it("says what is being verified", () => {
			const { stdout } = render([
				{ type: "verification_started", verifyId: "v1", items: [2, 5], declaration: [{ items: [2, 5], reason: "x" }] },
			]);
			expect(stdout).toBe("◇ verifying · items 2, 5\n");
		});

		it("shows a round with its defects and severities, and that they go to the agent", () => {
			const { stdout } = render([
				round({
					defects: [defect(), defect({ id: "D2", severity: "major" })],
					blocking: ["D1", "D2"],
					correcting: true,
				}),
			]);
			expect(stdout).toBe("◇ verify · round 1 · 2 defects (blocker, major) · asking the agent to fix them\n");
		});

		it("counts the requirements, the defects that are also on the base, and a round without defects", () => {
			const { stdout } = render([
				round({ requirements: [requirement("met"), requirement("unmet", "R2"), requirement("unverified", "R3")] }),
				round({ round: 2, defects: [defect({ onBase: true }), defect({ id: "D2", severity: "minor" })] }),
			]);
			expect(stdout).toBe(
				[
					"◇ verify · round 1 · no defects · 1 met, 1 unmet, 1 unverified",
					"◇ verify · round 2 · 2 defects (blocker, minor), 1 also on the base",
					"",
				].join("\n"),
			);
		});

		it("says a verifier that failed did not pass", () => {
			const { stdout } = render([round({ ok: false, error: "The verifier returned an invalid report: no JSON" })]);
			expect(stdout).toBe("◇ verify · round 1 · failed: The verifier returned an invalid report: no JSON\n");
		});

		it("ends passed, passed after a correction, or failed", () => {
			const { stdout } = render([
				done(),
				done({ outcome: "corrected", rounds: 2, costUsd: 0.0421 }),
				done({ outcome: "failed", reason: "model down" }),
			]);
			expect(stdout).toBe(
				[
					"✓ verify passed",
					"✓ verify passed after a correction · 2 rounds · $0.0421",
					"✗ verify failed: model down · needs your decision",
					"",
				].join("\n"),
			);
		});

		it("says what could not be verified when nothing else is open", () => {
			const { stdout } = render([
				done({
					outcome: "needs_decision",
					reason: "1 unverified requirement: R1 the approval needs a keypress (could not run it)",
				}),
			]);
			expect(stdout).toBe(
				"✗ verify: needs your decision · 1 unverified requirement: R1 the approval needs a keypress (could not run it)\n",
			);
		});

		it("lists the open defects when the user must decide", () => {
			const { stdout } = render([
				done({ outcome: "needs_decision", rounds: 2, openDefects: [defect({ id: "D2", severity: "major" })] }),
				done({
					outcome: "needs_decision",
					reason: "The correction failed.",
					openDefects: [defect(), defect({ id: "D2" })],
				}),
			]);
			expect(stdout).toBe(
				[
					"✗ verify: needs your decision · 1 open defect",
					"  D2 major — A pasted y approves the command",
					"    reproduce: printf 'ls\\ny' | node cli.ts",
					"✗ verify: needs your decision · 2 open defects · The correction failed.",
					"  D1 blocker — A pasted y approves the command",
					"    reproduce: printf 'ls\\ny' | node cli.ts",
					"  D2 blocker — A pasted y approves the command",
					"    reproduce: printf 'ls\\ny' | node cli.ts",
					"",
				].join("\n"),
			);
		});

		it("shows the cause and the value observed instead of the message", () => {
			const { stdout } = render([
				round({
					ok: false,
					error: "The verifier returned an invalid report: no JSON",
					cause: "invalid_report",
					observed: "looks fine to me",
				}),
				done({ outcome: "failed", reason: "turn_limit: ...", cause: "request_cap", observed: "80 requests" }),
				done({ outcome: "failed", reason: "interrupted", cause: "interrupted" }),
				done({
					outcome: "needs_decision",
					reason: "1 unverified requirement: R1 the approval needs a keypress (bash was not available)",
					cause: "sandbox_unavailable",
					observed: "sandbox not available on this platform",
				}),
				done({
					outcome: "needs_decision",
					rounds: 2,
					openDefects: [defect({ id: "D2", severity: "major" })],
					cause: "open_defects",
					observed: "D2",
				}),
			]);
			expect(stdout).toBe(
				[
					"◇ verify · round 1 · failed: invalid_report (looks fine to me)",
					"✗ verify failed: request_cap (80 requests) · needs your decision",
					"✗ verify failed: interrupted · needs your decision",
					"✗ verify: needs your decision · sandbox_unavailable (sandbox not available on this platform) · 1 unverified requirement: R1 the approval needs a keypress (bash was not available)",
					"✗ verify: needs your decision · open_defects (D2)",
					"  D2 major — A pasted y approves the command",
					"    reproduce: printf 'ls\\ny' | node cli.ts",
					"",
				].join("\n"),
			);
		});

		it("nests the verifier's own work like a subagent", () => {
			const { stdout } = render([
				{ type: "text_delta", text: "probing", parentCallId: "v1", agent: "verify:verifier" },
			] as never);
			expect(stdout).toBe("  │ probing");
		});
	});
});
