import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { describe, expect, it } from "vitest";
import { emptySidePanel, MAX_FINISHED_ROWS, type SidePanelState, sidePanelAfter } from "../src/tui/side-panel-state.ts";

type Body = AtelierEventBody & { parentCallId?: string; agent?: string };
const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
});

/** Feeds the events one second apart, from `start`. */
function after(bodies: Body[], state: SidePanelState = emptySidePanel(), start = 1000): SidePanelState {
	return bodies.reduce(
		(current, body, i) =>
			sidePanelAfter(current, { ...body, seq: i + 1, turnId: "t" } as AtelierEvent, start + i * 1000),
		state,
	);
}

const jobStarted = (jobId: string, label = jobId): Body => ({
	type: "job_started",
	jobId,
	label,
	command: label,
	outputPath: `/tmp/${jobId}`,
	running: 1,
});
const jobFinished = (jobId: string, extra: Partial<Extract<Body, { type: "job_finished" }>> = {}): Body => {
	const { exitCode = 0, ...rest } = extra;
	return {
		type: "job_finished",
		jobId,
		label: jobId,
		status: "exited",
		...(rest.status === "stopped" ? {} : { exitCode }),
		durationMs: 5000,
		outputPath: `/tmp/${jobId}`,
		notified: true,
		running: 0,
		waiting: 1,
		...rest,
	};
};
const turnFinished = (extra: Partial<Extract<Body, { type: "turn_finished" }>> = {}): Body => ({
	type: "turn_finished",
	stopReason: "end_turn",
	usage: usage(0, 0),
	...extra,
});

describe("side panel state", () => {
	it("lists jobs as they start and end, and marks a notice the agent has not read until it reads it", () => {
		const state = after([
			jobStarted("job-1", "pnpm check"),
			jobStarted("job-2", "dev server"),
			jobFinished("job-1", { status: "exited", exitCode: 1, waiting: 1 }),
			jobFinished("job-2", { status: "stopped", notified: false, waiting: 1 }),
		]);
		expect(state.jobs).toEqual([
			{
				id: "job-1",
				label: "pnpm check",
				status: "exited",
				exitCode: 1,
				startedAt: 1000,
				durationMs: 5000,
				endedAt: 3000,
			},
			{ id: "job-2", label: "dev server", status: "stopped", startedAt: 2000, durationMs: 5000, endedAt: 4000 },
		]);
		expect(state.unread).toEqual(["job:job-1"]);
		const read = after([{ type: "jobs_status", running: 0, waiting: 0 }], state);
		expect(read.unread).toEqual([]);
	});

	it("keeps the newest unread notices when the session says fewer wait", () => {
		const state = after([
			jobStarted("a"),
			jobStarted("b"),
			jobFinished("a", { waiting: 1 }),
			jobFinished("b", { waiting: 2 }),
			{ type: "jobs_status", running: 0, waiting: 1 },
		]);
		expect(state.unread).toEqual(["job:b"]);
	});

	it("keeps every running job and the latest finished ones", () => {
		const bodies: Body[] = [jobStarted("still")];
		for (let i = 0; i < MAX_FINISHED_ROWS + 5; i++)
			bodies.push(jobStarted(`j${i}`), jobFinished(`j${i}`, { waiting: 0 }));
		const state = after(bodies);
		expect(state.jobs).toHaveLength(MAX_FINISHED_ROWS + 1);
		expect(state.jobs[0]?.id).toBe("still");
		expect(state.jobs.at(-1)?.id).toBe(`j${MAX_FINISHED_ROWS + 4}`);
		expect(state.jobs.some((job) => job.id === "j0")).toBe(false);
	});

	it("follows a foreground subagent through its call and its own events, and a background one through its task", () => {
		const state = after([
			{
				type: "tool_call_started",
				callId: "c1",
				tool: "task",
				input: { agent: "worker", prompt: "\nFix the footer cost\nmore" },
			},
			{
				type: "session_started",
				backend: "fake",
				model: "sonnet-5-5",
				authSource: "none",
				parentCallId: "c1",
				agent: "worker",
			} as Body,
			{ type: "tool_call_started", callId: "k1", tool: "edit", input: { path: "footer.ts" }, parentCallId: "c1" },
			{
				type: "task_started",
				taskId: "task-1",
				agent: "explorer",
				label: "cache calc",
				model: "opus-5-5",
				outputPath: "/tmp/task-1.md",
				running: 1,
			},
		]);
		expect(state.agents).toEqual([
			{
				key: "c1",
				agent: "worker",
				label: "Fix the footer cost",
				background: false,
				status: "running",
				model: "sonnet-5-5",
				tool: { callId: "k1", label: "edit footer.ts" },
				startedAt: 1000,
			},
			{
				key: "task-1",
				agent: "explorer",
				label: "cache calc",
				background: true,
				status: "running",
				model: "opus-5-5",
				startedAt: 4000,
			},
		]);
		const ended = after(
			[
				{ type: "tool_call_finished", callId: "k1", ok: true, summary: "", truncated: false, parentCallId: "c1" },
				turnFinished({ usage: usage(100, 20, 300), costUsd: 0.05, parentCallId: "c1", agent: "worker" } as never),
				{ type: "tool_call_finished", callId: "c1", ok: true, summary: "worker: 10 characters", truncated: false },
				{
					type: "task_finished",
					taskId: "task-1",
					agent: "explorer",
					label: "cache calc",
					status: "finished",
					durationMs: 215_000,
					outputPath: "/tmp/task-1.md",
					usage: usage(1000, 22_000, 300_000),
					costUsd: 0.11,
					notified: true,
					running: 0,
					waiting: 1,
				},
			],
			state,
			10_000,
		);
		expect(ended.agents).toEqual([
			expect.objectContaining({
				key: "c1",
				status: "finished",
				usage: usage(100, 20, 300),
				costUsd: 0.05,
				durationMs: 11_000,
			}),
			expect.objectContaining({
				key: "task-1",
				status: "finished",
				usage: usage(1000, 22_000, 300_000),
				costUsd: 0.11,
			}),
		]);
		expect(ended.agents[0]?.tool).toBeUndefined();
		expect(ended.unread).toEqual(["task:task-1"]);
		expect(ended.status.tokens).toEqual(usage(1100, 22_020, 300_300));
	});

	it("ends a foreground subagent the turn left running, with why", () => {
		const state = after([
			{ type: "tool_call_started", callId: "c1", tool: "task", input: { agent: "worker", prompt: "Docs update" } },
			turnFinished({ stopReason: "interrupted" }),
		]);
		expect(state.agents).toEqual([
			expect.objectContaining({ key: "c1", status: "failed", error: "interrupted", durationMs: 1000 }),
		]);
	});

	it("says why a foreground subagent failed", () => {
		const state = after([
			{ type: "tool_call_started", callId: "c1", tool: "task", input: { agent: "worker", prompt: "x" } },
			{ type: "tool_call_finished", callId: "c1", ok: false, summary: "worker returned no report", truncated: false },
		]);
		expect(state.agents[0]).toMatchObject({ status: "failed", error: "worker returned no report" });
	});

	it("leaves a background task call to its task events", () => {
		const state = after([
			{
				type: "tool_call_started",
				callId: "c1",
				tool: "task",
				input: { agent: "explorer", prompt: "x", background: true },
			},
		]);
		expect(state.agents).toEqual([]);
	});

	it("counts every turn's tokens, the subagents' too, but not the review's and the verifier's twice", () => {
		const state = after([
			turnFinished({ usage: usage(10, 1, 100, 5) }),
			turnFinished({ usage: usage(7, 2), parentCallId: "c9", agent: "worker" } as never),
			turnFinished({ usage: usage(50, 5), parentCallId: "r1", agent: "review:risk" } as never),
			turnFinished({ usage: usage(60, 6), parentCallId: "v1", agent: "verify:verifier" } as never),
		]);
		expect(state.status.tokens).toEqual(usage(17, 3, 100, 5));
		expect(state.status.turns).toBe(1);
	});

	it("sums the main agent's own requests over its turns for its cache rate, never the other phases", () => {
		const state = after([
			turnFinished({
				usage: usage(1100, 10, 0, 0),
				phases: { main: { usage: usage(100, 5, 0, 900) }, classifier: { usage: usage(1000, 5) } },
			}),
			turnFinished({ usage: usage(10, 10, 990), phases: { main: { usage: usage(10, 10, 990) } } }),
			turnFinished({ usage: usage(5, 5), parentCallId: "c1", agent: "worker" } as never),
		]);
		expect(state.status.main).toEqual(usage(110, 15, 990, 900));
		expect(state.status.turns).toBe(2);
	});

	it("says the compactions, memory, MCP servers, reviews, instructions and skills", () => {
		const state = after([
			{
				type: "compaction_finished",
				ok: true,
				reason: "threshold",
				tokensBefore: 180_000,
				tokensAfter: 40_000,
				kept: 4,
				usage: usage(1, 1),
			},
			{
				type: "compaction_finished",
				ok: false,
				reason: "threshold",
				tokensBefore: 1,
				kept: 0,
				usage: usage(1, 1),
				error: "x",
			},
			{ type: "memory_status", available: true, project: "atelier" },
			{ type: "memory_summary_saved", id: 5510, preview: "## Goal" },
			{
				type: "mcp_status",
				servers: [
					{ name: "docs", state: "connected", tools: ["a"] },
					{ name: "github", state: "failed", tools: [], error: "no answer" },
				],
				problems: ["github: no answer"],
			},
			{ type: "review_status", available: false, reason: "no reviewer model" },
			{
				type: "review_finished",
				reviewId: "r1",
				verdict: "approved",
				findings: [{ id: "F1" } as never, { id: "F2" } as never],
				refuted: [],
				followUps: [],
				correction: null,
				usage: usage(1, 1),
			},
			{ type: "project_instructions", files: ["AGENTS.md"], dropped: [] },
			{
				type: "skills_loaded",
				skills: [
					{ name: "a", path: "a" },
					{ name: "b", path: "b" },
				],
				warnings: [],
			},
		]);
		expect(state.status).toMatchObject({
			compactions: 1,
			lastCompaction: { before: 180_000, after: 40_000 },
			memory: { available: true, project: "atelier", savedId: 5510 },
			mcp: { servers: 2, failed: ["github"], problems: ["github: no answer"] },
			review: { available: false, reason: "no reviewer model" },
			reviews: 1,
			findings: 2,
			instructions: ["AGENTS.md"],
			skills: 2,
		});
	});

	it("keeps the main agent's feature with each task's note, and ignores a subagent's", () => {
		const feature: Body = {
			type: "feature_changed",
			name: "panel",
			path: "odd/tasks/panel.md",
			title: "TUI status panel",
			tasks: [{ id: "T4", title: "Footer", specs: [], status: "blocked", note: "decide the cache scope" }],
		};
		const state = after([feature, { ...feature, title: "child's", parentCallId: "c1" }]);
		expect(state.feature?.title).toBe("TUI status panel");
		expect(state.feature?.tasks[0]?.note).toBe("decide the cache scope");
	});
});
