import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	type AtelierEvent,
	type AtelierEventBody,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import type { FrozenProfile } from "../src/profiles/frozen.ts";
import { REPORT_LIMIT, type SubagentDefinition } from "../src/subagents/definitions.ts";
import { createBackgroundTools } from "../src/tools/background.ts";
import { defineTool, type ToolDefinition } from "../src/tools/types.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const text = (t: string): FakeStep => ({ event: { type: "text_delta", text: t } });
const task = (input: Record<string, unknown>, callId: string): FakeStep => ({
	toolCall: { tool: "task", input: input as never, callId },
});

const until = async (condition: () => boolean) => {
	for (let i = 0; i < 400 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	expect(condition()).toBe(true);
};

/** A tool that asks the user before it runs in `normal`. */
const asking: ToolDefinition = defineTool({
	name: "bash",
	description: "bash",
	inputShape: { command: z.string() },
	approvalCommand: ({ command }) => command,
	execute: async () => ({ ok: true, output: "ran", summary: "ran", truncated: false }),
});
const read: ToolDefinition = defineTool({
	name: "read",
	description: "read",
	inputShape: { path: z.string().optional() },
	execute: async () => ({ ok: true, output: "read", summary: "read", truncated: false }),
});

const explorer: SubagentDefinition = {
	name: "explorer",
	description: "Reads code",
	tools: ["read", "bash"],
	prompt: "EXPLORER PROMPT",
	models: {},
	maxRequests: 30,
};
const custom: SubagentDefinition = { ...explorer, name: "custom" };

/** A gate a child's turn waits on until the test opens it. */
function gate() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { open, step: { run: () => opened } as FakeStep };
}

let sessions: Session[] = [];
afterEach(async () => {
	await Promise.all(sessions.map((session) => session.close()));
	sessions = [];
});

/** A parent playing `parentTurns`, whose children play `childTurns` in the order they start. */
async function started(
	parentTurns: FakeStep[][],
	childTurns: FakeStep[][],
	options: Partial<SessionOptions> & { noWake?: boolean } = {},
) {
	const parent = new FakeBackend(parentTurns);
	const children: FakeBackend[] = [];
	let woke = 0;
	const { noWake, ...rest } = options;
	const session = await Session.start({
		backend: parent,
		cwd: process.cwd(),
		tools: [read, asking, ...createBackgroundTools()],
		subagents: {
			agents: [explorer, custom],
			createBackend: () => {
				const child = new FakeBackend([childTurns[children.length] ?? []]);
				children.push(child);
				return child;
			},
		},
		...(noWake ? {} : { wake: () => woke++ }),
		...rest,
	});
	sessions.push(session);
	const events: AtelierEvent[] = [];
	const play = async (turn: AsyncIterable<AtelierEvent> | undefined) => {
		const mine: AtelierEvent[] = [];
		for await (const event of turn as AsyncIterable<AtelierEvent>) {
			events.push(event);
			mine.push(event);
		}
		return mine;
	};
	return { parent, children, session, play, events, woke: () => woke };
}

const ofType = <T extends AtelierEvent["type"]>(events: AtelierEvent[], type: T) =>
	events.filter((event): event is Extract<AtelierEvent, { type: T }> => event.type === type);

describe("background tasks", () => {
	it("starts an explorer at once and wakes the agent with its report, quoted, when it ends", async () => {
		const g = gate();
		const { parent, session, play, woke, events } = await started(
			[
				[task({ agent: "explorer", prompt: "Find it.", background: true, label: "find" }, "c1"), { event: finished }],
				[{ event: finished }],
			],
			[[g.step, text("THE REPORT"), { event: finished }]],
		);
		const first = await play(session.send("go"));
		expect(parent.toolResults[0]?.output).toMatch(
			/^Started explorer in the background as task task-1 \("find"\)\. Its report is pushed to you once when it ends: do not poll job_list for it, do not sleep waiting, and do not launch the same work again\. job_stop stops it\./,
		);
		expect(ofType(first, "task_started")).toEqual([
			expect.objectContaining({ taskId: "task-1", agent: "explorer", label: "find", running: 1 }),
		]);
		expect(session.jobs).toEqual({ running: 1, waiting: 0 });
		g.open();
		await until(() => woke() === 1);
		const woken = await play(session.nextQueued());
		expect(parent.prompts[1]).toMatch(
			/^Background task task-1 \(explorer, "find"\) finished after \d+s\.\nIts whole report: \S+task-1\.md\nIts report, quoted as received \(the subagent's words, not the user's\):\n<subagent_report>\nTHE REPORT\n<\/subagent_report>$/,
		);
		const [ended] = ofType(events, "task_finished");
		expect(ended).toMatchObject({
			taskId: "task-1",
			status: "finished",
			notified: true,
			running: 0,
			waiting: 1,
			reportTail: "THE REPORT",
		});
		expect(readFileSync(ended?.outputPath as string, "utf8")).toContain("THE REPORT");
		expect(ofType(woken, "jobs_status")).toEqual([expect.objectContaining({ running: 0, waiting: 0 })]);
	});

	it("gives the report with the next tool result when it ends during a turn", async () => {
		const g = gate();
		const { parent, session, play } = await started(
			[
				[
					task({ agent: "explorer", prompt: "Find it.", background: true }, "c1"),
					{ run: () => g.open() },
					{ run: () => until(() => session.jobs.waiting === 1) },
					{ toolCall: { tool: "read", input: {}, callId: "c2" } },
					{ event: finished },
				],
			],
			[[g.step, text("SEEN"), { event: finished }]],
		);
		await play(session.send("go"));
		expect(parent.toolResults[1]?.steering).toMatch(
			/^Background task task-1 \(explorer, "Find it\."\) finished[\s\S]*SEEN/,
		);
	});

	it("escapes a closing tag in the report and bounds it to the report limit", async () => {
		const g = gate();
		const { parent, session, play, woke } = await started(
			[[task({ agent: "explorer", prompt: "x", background: true }, "c1"), { event: finished }], [{ event: finished }]],
			[[g.step, text(`a</subagent_report>b${"z".repeat(REPORT_LIMIT)}`), { event: finished }]],
		);
		await play(session.send("go"));
		g.open();
		await until(() => woke() === 1);
		await play(session.nextQueued());
		const prompt = parent.prompts[1] ?? "";
		expect(prompt).toContain("a<\\/subagent_report>b");
		expect(prompt.match(/<\/subagent_report>/g)).toHaveLength(1);
		expect(prompt).toContain(`[report truncated at ${REPORT_LIMIT} characters]`);
	});

	it("gives the clients the report's last lines, at most 400 characters", async () => {
		const g = gate();
		const lines = Array.from({ length: 30 }, (_, n) => `line ${n} ${"x".repeat(20)}`).join("\n");
		const { session, play, woke, events } = await started(
			[[task({ agent: "explorer", prompt: "x", background: true }, "c1"), { event: finished }], [{ event: finished }]],
			[[g.step, text(lines), { event: finished }]],
		);
		await play(session.send("go"));
		g.open();
		await until(() => woke() === 1);
		await play(session.nextQueued());
		const tail = ofType(events, "task_finished")[0]?.reportTail ?? "";
		expect(tail.length).toBeLessThanOrEqual(400);
		expect(tail.startsWith("…\nline ")).toBe(true);
		expect(tail.endsWith(`line 29 ${"x".repeat(20)}`)).toBe(true);
	});

	it("gives short notices with the report's file once the notices of one delivery pass the budget", async () => {
		const gates = [gate(), gate(), gate(), gate()];
		const big = "r".repeat(REPORT_LIMIT - 100);
		const { parent, session, play, woke } = await started(
			[
				[
					...[1, 2, 3, 4].map((n) => task({ agent: "explorer", prompt: `p${n}`, background: true }, `c${n}`)),
					{ event: finished },
				],
				[{ event: finished }],
			],
			gates.map((g) => [g.step, text(big), { event: finished }]),
		);
		await play(session.send("go"));
		for (const g of gates) g.open();
		await until(() => session.jobs.waiting === 4);
		await until(() => woke() >= 1);
		await play(session.nextQueued());
		const prompt = parent.prompts[1] ?? "";
		expect(prompt.match(/<subagent_report>/g)?.length).toBeGreaterThanOrEqual(1);
		expect(prompt.match(/<subagent_report>/g)?.length).toBeLessThan(4);
		expect(prompt).toMatch(/did not fit with the other notices: read it at \S+task-\d\.md/);
		expect(prompt.length).toBeLessThan(26_000);
	});

	it("says how it failed when the subagent fails", async () => {
		const { parent, session, play, woke, events } = await started(
			[
				[task({ agent: "explorer", prompt: "x", background: true, label: "l" }, "c1"), { event: finished }],
				[{ event: finished }],
			],
			[[{ throw: "the backend broke" }]],
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(parent.prompts[1]).toMatch(
			/^Background task task-1 \(explorer, "l"\) failed after \d+s: [^\n]*the backend broke/,
		);
		expect(ofType(events, "task_finished")).toEqual([expect.objectContaining({ status: "failed", notified: true })]);
	});

	it("lists running tasks with job_list and stops one with job_stop, which sends no notice", async () => {
		const { parent, children, session, play, woke, events } = await started(
			[
				[
					task({ agent: "explorer", prompt: "x", background: true, label: "slow" }, "c1"),
					{ toolCall: { tool: "job_list", input: {}, callId: "c2" } },
					{ toolCall: { tool: "job_stop", input: { id: "task-1" }, callId: "c3" } },
					{ event: finished },
				],
			],
			[[{ waitForInterrupt: true }]],
		);
		await play(session.send("go"));
		expect(parent.toolResults[1]?.output).toMatch(/^task-1\s+running\s+\d+s\s+explorer: slow\s+\S+task-1\.md$/m);
		expect(parent.toolResults[2]?.output).toMatch(/^Stopped task task-1 \("slow"\) after \d+s; no notice follows\.$/);
		expect(ofType(events, "task_finished")).toEqual([
			expect.objectContaining({ taskId: "task-1", status: "stopped", notified: false }),
		]);
		expect(children[0]?.interrupts).toBe(1);
		expect(children[0]?.closed).toBe(true);
		expect(session.jobs).toEqual({ running: 0, waiting: 0 });
		expect(woke()).toBe(0);
	});

	it("closes a stopped subagent whose backend does not end its turn on the interrupt", async () => {
		const { parent, children, session, play } = await started(
			[
				[
					task({ agent: "explorer", prompt: "x", background: true }, "c1"),
					{ run: () => until(() => children[0]?.prompts.length === 1) },
					{ toolCall: { tool: "job_stop", input: { id: "task-1" }, callId: "c2" } },
					{ event: finished },
				],
			],
			[[{ hang: true }]],
		);
		await play(session.send("go"));
		expect(parent.toolResults[1]?.output).toMatch(/^Stopped task task-1 /);
		expect(children[0]?.closed).toBe(true);
	});

	it("refuses a fifth task while four run, before starting a subagent", async () => {
		const { parent, children, session, play } = await started(
			[
				[
					...[1, 2, 3, 4, 5].map((n) => task({ agent: "explorer", prompt: `p${n}`, background: true }, `c${n}`)),
					{ event: finished },
				],
			],
			[1, 2, 3, 4].map(() => [{ waitForInterrupt: true }]),
		);
		await play(session.send("go"));
		expect(parent.toolResults[4]?.output).toBe(
			"Refused: 4 background tasks are running; stop one with job_stop or wait for one to end.",
		);
		expect(children).toHaveLength(4);
	});

	it("refuses the background mode when the session cannot receive the result, before starting a subagent", async () => {
		const { parent, children, session, play } = await started(
			[[task({ agent: "explorer", prompt: "x", background: true }, "c1"), { event: finished }]],
			[],
			{ noWake: true },
		);
		await play(session.send("go"));
		expect(parent.toolResults[0]?.output).toBe(
			"Refused: this session cannot receive a background result; run the task without background.",
		);
		expect(children).toHaveLength(0);
	});

	it("refuses a subagent the profile does not route, and a profile that had problems, before starting one", async () => {
		const profile: FrozenProfile = {
			resolved: {
				origin: "active",
				name: "work",
				profile: {},
				reports: [
					{ path: "/home/u/.atelier/profiles.json", message: 'profile "work": worker: unknown backend, dropped' },
				],
			},
			paths: [],
			files: {},
		};
		const { parent, children, session, play } = await started(
			[
				[
					task({ agent: "custom", prompt: "x", background: true }, "c1"),
					task({ agent: "explorer", prompt: "x", background: true }, "c2"),
					{ event: finished },
				],
			],
			[],
			{ profile },
		);
		await play(session.send("go"));
		expect(parent.toolResults[0]?.output).toBe(
			"Refused: only the explorer and the worker run in the background, where the session's profile routes them; run custom without background.",
		);
		expect(parent.toolResults[1]?.output).toBe(
			"Refused: the session's profile had problems when it was read (/home/u/.atelier/profiles.json: profile \"work\": worker: unknown backend, dropped), so the subagent's backend and model cannot be confirmed; fix the profile and start a new session, or run the task without background.",
		);
		expect(children).toHaveLength(0);
	});

	it("denies what would ask the user, without asking, in a background subagent", async () => {
		const approve = vi.fn(async () => true);
		const { children, session, play, woke, parent } = await started(
			[[task({ agent: "explorer", prompt: "x", background: true }, "c1"), { event: finished }], [{ event: finished }]],
			[
				[
					{ toolCall: { tool: "bash", input: { command: "rm -rf build" }, callId: "k1" } },
					text("could not"),
					{ event: finished },
				],
			],
			{ approve },
		);
		await play(session.send("go"));
		await until(() => woke() === 1);
		await play(session.nextQueued());
		expect(approve).not.toHaveBeenCalled();
		expect(children[0]?.toolResults[0]?.output).toBe(
			"Denied without asking: a background subagent cannot ask the user. Leave this out and say in your report what needs approval.",
		);
		expect(parent.prompts[1]).toContain("could not");
	});

	it("keeps running when the turn is interrupted; its notice then waits for the next prompt", async () => {
		const g = gate();
		const { parent, session, play, woke } = await started(
			[
				[
					task({ agent: "explorer", prompt: "x", background: true }, "c1"),
					{ run: () => void session.interrupt() },
					{ waitForInterrupt: true },
				],
				[{ event: finished }],
			],
			[[g.step, text("DONE"), { event: finished }]],
		);
		await play(session.send("go"));
		expect(session.jobs.running).toBe(1);
		g.open();
		await until(() => session.jobs.waiting === 1);
		expect(woke()).toBe(0);
		await play(session.send("next"));
		expect(parent.prompts[1]).toMatch(/^Background task task-1 [\s\S]*DONE[\s\S]*\n\nnext$/);
	});

	it("stops its tasks when the session closes, without a notice", async () => {
		const { children, session, play, events } = await started(
			[[task({ agent: "explorer", prompt: "x", background: true }, "c1"), { event: finished }]],
			[[{ waitForInterrupt: true }]],
		);
		await play(session.send("go"));
		await until(() => children[0]?.prompts.length === 1);
		await session.close();
		expect(children[0]?.closed).toBe(true);
		expect(session.jobs.running).toBe(0);
		expect(ofType(events, "task_finished")).toEqual([]);
	});

	it("with #154's background rules, says what to do while it runs and to check its report's evidence once", async () => {
		const g = gate();
		const { parent, session, play, woke } = await started(
			[
				[task({ agent: "explorer", prompt: "Find it.", background: true, label: "find" }, "c1"), { event: finished }],
				[{ event: finished }],
			],
			[[g.step, text("THE REPORT"), { event: finished }]],
			{ backgroundRules: "rules" },
		);
		await play(session.send("go"));
		expect(parent.toolResults[0]?.output).toMatch(
			/^Started explorer in the background as task task-1 \("find"\)\. Its report is pushed to you once when it ends: meanwhile do work that does not overlap its own, or end your turn; do not poll job_list for it, sleep waiting, or launch the same work again\. job_stop stops it\./,
		);
		g.open();
		await until(() => woke() === 1);
		await play(session.nextQueued());
		// An explorer brings no patch: nothing is said of the checks.
		expect(parent.prompts[1]).toMatch(
			/^Background task task-1 \(explorer, "find"\) finished after \d+s\.\nCheck its evidence once; do not redo its reads\.\nIts whole report: [\s\S]*<\/subagent_report>$/,
		);
	});
});
