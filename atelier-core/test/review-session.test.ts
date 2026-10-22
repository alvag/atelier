import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentBackend, BackendSession, BackendStartOptions } from "../src/backend.ts";
import {
	type AtelierEvent,
	type AtelierEventBody,
	decodeServerMessage,
	FakeBackend,
	type FakeStep,
	RpcServer,
	type ServerMessage,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { RISK_RULES } from "../src/prompt.ts";
import { LENS_INSTRUCTIONS } from "../src/review/lenses.ts";
import { REFUTER_INSTRUCTION, VALIDATOR_INSTRUCTION } from "../src/review/roles.ts";
import { reviewEnabled } from "../src/server/rpc-server.ts";
import type { SubagentDefinition } from "../src/subagents/definitions.ts";
import { defineTool } from "../src/tools/types.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const text = (t: string): FakeStep => ({ event: { type: "text_delta", text: t } });
const call = (tool: string, input: Record<string, unknown>, callId = `c-${tool}`): FakeStep => ({
	toolCall: { tool, input: input as never, callId },
});
/** The main agent changing a file of the worktree. */
const change = (path: string, content: string): FakeStep => call("change", { path, content }, `c-${path}`);

const changeTool = defineTool({
	name: "change",
	description: "Writes a file",
	inputShape: { path: z.string(), content: z.string() },
	execute: async ({ path, content }, { cwd }) => {
		await mkdir(dirname(join(cwd, path)), { recursive: true });
		await writeFile(join(cwd, path), content);
		return { ok: true, output: "written", summary: path, truncated: false };
	},
});

/** A git repo with one commit and a clean worktree. */
async function repo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "atelier-review-session-"));
	dirs.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });
	git("init", "-q");
	await writeFile(join(root, "a.ts"), "base\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	return root;
}

async function receipts(root: string): Promise<{ file: string; receipt: { verdict: string } }[]> {
	const dir = join(root, ".git", "atelier", "reviews");
	const names = await readdir(dir).catch(() => [] as string[]);
	return Promise.all(
		names
			.filter((name) => name.endsWith(".json"))
			.map(async (file) => ({ file, receipt: JSON.parse(await readFile(join(dir, file), "utf8")) })),
	);
}

const HOLD = Symbol("hold");
type Reply = string | typeof HOLD;

/** The review roles' backend: answers by role, recording what each one saw. */
class RoleBackend implements AgentBackend {
	readonly id = "fake";
	readonly roles: { role: string; tools: string[]; model?: string; prompt: string }[] = [];
	interrupts = 0;
	readonly #reply: (role: string, prompt: string) => Reply;

	constructor(reply: (role: string, prompt: string) => Reply = defaultReply) {
		this.#reply = reply;
	}

	async start(options: BackendStartOptions): Promise<BackendSession> {
		const role = roleOf(options.systemPromptAppend);
		const reply = this.#reply;
		const roles = this.roles;
		const tools = options.tools.map((tool) => tool.name);
		let release: (() => void) | undefined;
		const backend = this;
		return {
			async *send(prompt: string): AsyncIterable<AtelierEventBody> {
				roles.push({ role, tools, prompt, ...(options.model === undefined ? {} : { model: options.model }) });
				const answer = reply(role, prompt);
				if (answer === HOLD) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					yield { type: "turn_finished", stopReason: "interrupted", usage: { ...usage, input: 2, output: 2 } };
					return;
				}
				yield { type: "text_delta", text: answer };
				yield { type: "turn_finished", stopReason: "end_turn", usage: { ...usage, input: 2, output: 2 } };
			},
			async interrupt() {
				backend.interrupts++;
				release?.();
			},
			async close() {},
		};
	}
}

function roleOf(instruction: string): string {
	if (instruction === REFUTER_INSTRUCTION) return "refuter";
	if (instruction === VALIDATOR_INSTRUCTION) return "validator";
	return Object.entries(LENS_INSTRUCTIONS).find(([, value]) => value === instruction)?.[0] ?? "unknown";
}

const idsIn = (prompt: string) => [...prompt.matchAll(/"id": "([A-Z]+-\d+)"/g)].map((m) => m[1] as string);
const severe = {
	id: "x",
	severity: "critical",
	cause: "candidate",
	path: "src/auth.ts",
	line: 1,
	claim: "The token is dropped.",
	evidence: "src/auth.ts:1",
};
/** No findings, except one severe finding from the reliability lens; the refuter confirms and the validator resolves. */
function defaultReply(role: string, prompt: string): string {
	if (role === "refuter")
		return JSON.stringify({ verdicts: idsIn(prompt).map((id) => ({ id, verdict: "confirmed", reason: "it holds" })) });
	if (role === "validator")
		return JSON.stringify({ results: idsIn(prompt).map((id) => ({ id, resolved: true, evidence: "src/auth.ts:1" })) });
	return JSON.stringify({ findings: role === "reliability" ? [{ lens: role, ...severe }] : [] });
}
const clean = (role: string, prompt: string) =>
	role === "refuter" || role === "validator" ? defaultReply(role, prompt) : JSON.stringify({ findings: [] });

async function collect(stream: AsyncIterable<AtelierEvent>): Promise<AtelierEvent[]> {
	const events: AtelierEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}
const types = (events: AtelierEvent[]) => events.map((event) => event.type);
const ofType = <T extends AtelierEventBody["type"]>(events: AtelierEvent[], type: T) =>
	events.filter((event): event is Extract<AtelierEvent, { type: T }> => event.type === type);

interface Setup {
	turns?: FakeStep[][];
	roles?: RoleBackend;
	review?: false;
	consent?: "granted" | "declined" | "none" | ((request: unknown) => Promise<"granted" | "declined">);
	cwd?: string;
	extra?: Partial<SessionOptions>;
}

async function start(setup: Setup = {}) {
	const cwd = setup.cwd ?? (await repo());
	const main = new FakeBackend(setup.turns ?? []);
	const roles = setup.roles ?? new RoleBackend();
	const asked: unknown[] = [];
	const answer = setup.consent ?? "granted";
	const consent =
		answer === "none"
			? undefined
			: async (request: unknown) => {
					asked.push(request);
					return typeof answer === "function" ? answer(request) : answer;
				};
	const session = await Session.start({
		backend: main,
		cwd,
		tools: [changeTool],
		...(setup.review === false
			? {}
			: { review: { createBackend: () => roles, ...(consent ? { consent: consent as never } : {}) } }),
		...setup.extra,
	});
	return { session, main, roles, cwd, asked, send: (prompt: string) => collect(session.send(prompt)) };
}

const HIGH_TURN: FakeStep[] = [change("src/auth.ts", "export const a = 1;\n"), text("done"), { event: finished }];
const MEDIUM_TURN: FakeStep[] = [change("a.ts", "base\nmore\n"), text("done"), { event: finished }];

describe("the risk tool", () => {
	it("exists only when review is on, with its short rule in the system prompt", async () => {
		const on = await start({ turns: [[{ event: finished }]] });
		expect(on.main.startOptions?.tools.map((tool) => tool.name)).toContain("risk");
		expect(on.main.startOptions?.systemPromptAppend).toContain(RISK_RULES);
		expect(Buffer.byteLength(RISK_RULES)).toBeLessThanOrEqual(400);
		const off = await start({ review: false, turns: [[{ event: finished }]] });
		expect(off.main.startOptions?.tools.map((tool) => tool.name)).not.toContain("risk");
		expect(off.main.startOptions?.systemPromptAppend).not.toContain(RISK_RULES);
	});

	it("never reaches a subagent, even one that asks for it", async () => {
		const child = new FakeBackend([[text("report"), { event: finished }]]);
		const agent: SubagentDefinition = {
			name: "scout",
			description: "Looks",
			tools: ["risk", "change"],
			prompt: "SCOUT",
			models: {},
			maxRequests: 5,
		};
		const turns = [[call("task", { agent: "scout", prompt: "look" }), { event: finished }]];
		const s = await start({ turns, extra: { subagents: { agents: [agent], createBackend: () => child } } });
		await s.send("go");
		expect(child.startOptions?.tools.map((tool) => tool.name)).toEqual(["change"]);
		expect(child.startOptions?.systemPromptAppend).not.toContain(RISK_RULES);
	});
});

describe("end of turn", () => {
	it("assesses after a successful turn, before its single turn_finished", async () => {
		const s = await start({ turns: [MEDIUM_TURN] });
		const events = await s.send("edit");
		const assessed = ofType(events, "review_assessed");
		expect(assessed).toHaveLength(1);
		expect(assessed[0]).toMatchObject({
			level: "medium",
			files: ["a.ts"],
			changedLines: 1,
			lenses: ["reliability"],
			reviewDue: false,
		});
		expect(assessed[0]?.tree).toMatch(/^[0-9a-f]{40,64}$/);
		expect(types(events).filter((type) => type === "turn_finished")).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("turn_finished");
		expect(events.indexOf(assessed[0] as AtelierEvent)).toBeLessThan(events.length - 1);
		expect(s.asked).toEqual([]);
		expect(s.roles.roles).toEqual([]);
	});

	it("does nothing without review, with no changes, or after a failed or interrupted turn", async () => {
		const off = await start({ review: false, turns: [MEDIUM_TURN] });
		expect(types(await off.send("edit")).filter((type) => type.startsWith("review_"))).toEqual([]);

		const idle = await start({ turns: [[text("hi"), { event: finished }]] });
		expect(types(await idle.send("hi")).filter((type) => type.startsWith("review_"))).toEqual([]);

		const failed = await start({ turns: [[change("a.ts", "base\nmore\n"), { throw: "boom" }]] });
		const failedEvents = await failed.send("edit");
		expect(types(failedEvents).filter((type) => type.startsWith("review_"))).toEqual([]);
		expect(failedEvents.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error" });

		const interrupted = await start({ turns: [[change("a.ts", "base\nmore\n"), { waitForInterrupt: true }]] });
		const running = interrupted.send("edit");
		await new Promise((resolve) => setTimeout(resolve, 30));
		await interrupted.session.interrupt();
		const interruptedEvents = await running;
		expect(types(interruptedEvents).filter((type) => type.startsWith("review_"))).toEqual([]);
	});

	it("reports once per session why there is no review outside a git repo", async () => {
		const folder = await mkdtemp(join(tmpdir(), "atelier-review-nogit-"));
		dirs.push(folder);
		const s = await start({ cwd: folder, turns: [MEDIUM_TURN, MEDIUM_TURN, [{ event: finished }]] });
		const first = await s.send("one");
		const status = ofType(first, "review_status");
		expect(status).toHaveLength(1);
		expect(status[0]).toMatchObject({ available: false });
		expect(status[0]?.reason).toContain("not inside a git repository");
		expect(ofType(first, "review_assessed")).toEqual([]);
		const second = await s.send("two");
		expect(ofType(second, "review_status")).toEqual([]);
	});

	it("lets the model raise the risk with the risk tool, until the change is reviewed", async () => {
		const turns = [
			[call("risk", { items: [2], reason: "handles sessions" }), ...MEDIUM_TURN],
			[change("b.ts", "x\n"), { event: finished }],
		];
		const s = await start({ turns, consent: "declined" });
		const first = await s.send("edit");
		expect(ofType(first, "review_assessed")[0]).toMatchObject({ level: "high", reviewDue: true });
		expect(ofType(first, "review_assessed")[0]?.reasons.join("\n")).toContain("handles sessions");
		const second = await s.send("more");
		expect(ofType(second, "review_assessed")[0]).toMatchObject({ level: "medium", reviewDue: false });
	});
});

describe("consent and the cycle", () => {
	it("reviews a high-risk change with 4 lenses, one correction and a validator, and writes a receipt", async () => {
		const turns = [HIGH_TURN, [change("src/auth.ts", "export const a = 2;\n"), { event: finished }]];
		const s = await start({ turns });
		const events = await s.send("add auth");

		const [assessed] = ofType(events, "review_assessed");
		expect(assessed).toMatchObject({
			level: "high",
			reviewDue: true,
			lenses: ["risk", "resilience", "readability", "reliability"],
		});
		const [consent] = ofType(events, "review_consent_requested");
		expect(consent).toMatchObject({ level: "high", lenses: assessed?.lenses });
		expect(consent?.reasons).toEqual(assessed?.reasons);
		expect(s.asked).toEqual([
			{ reviewId: consent?.reviewId, level: "high", reasons: assessed?.reasons, lenses: assessed?.lenses },
		]);

		// The main agent was asked, in the same turn, for one correction that names the finding.
		expect(s.main.prompts).toHaveLength(2);
		expect(s.main.prompts[1]).toContain("RL-001");
		expect(s.roles.roles.map((role) => role.role).sort()).toEqual(
			["readability", "refuter", "reliability", "resilience", "risk", "validator"].sort(),
		);
		// Roles read the frozen tree and nothing else.
		for (const role of s.roles.roles) expect(role.tools.sort()).toEqual(["grep", "read"]);

		const [done] = ofType(events, "review_finished");
		expect(done).toMatchObject({
			reviewId: consent?.reviewId,
			verdict: "approved",
			findings: [{ id: "RL-001" }],
			refuted: [],
		});
		expect(done?.correction).toEqual({ budget: 2, used: 2 });
		expect(done?.receiptPath?.endsWith(join(".git", "atelier", "reviews", `${assessed?.tree}.json`))).toBe(true);
		expect(JSON.parse(await readFile(done?.receiptPath as string, "utf8"))).toMatchObject({ verdict: "approved" });
		expect(done?.usage.input).toBe(4 * 2 + 2 + 2 + 1);

		// Role events are nested under the review, tagged as subagents.
		const tagged = events.filter((event) => event.agent?.startsWith("review:"));
		expect(new Set(tagged.map((event) => event.agent))).toEqual(
			new Set([
				"review:risk",
				"review:resilience",
				"review:readability",
				"review:reliability",
				"review:refuter",
				"review:validator",
			]),
		);
		expect(tagged.every((event) => event.parentCallId === consent?.reviewId)).toBe(true);
		expect(ofType(events, "review_progress").length).toBeGreaterThan(0);

		// One turn_finished, last, with every role call and the correction summed in.
		expect(events.filter((event) => event.type === "turn_finished" && event.agent === undefined)).toHaveLength(1);
		const last = events.at(-1);
		expect(last).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
		expect(last?.type === "turn_finished" && last.usage).toEqual({
			input: 1 + 8 + 2 + 2 + 1,
			output: 14,
			cacheRead: 0,
			cacheWrite: 0,
		});
		expect(await receipts(s.cwd)).toHaveLength(2);

		// Neither the reviewed nor the corrected change is offered again.
		const next = await collect(s.session.send("hello"));
		expect(types(next).filter((type) => type.startsWith("review_"))).toEqual([]);
	});

	it("runs a clean review to approved without a correction", async () => {
		const s = await start({ turns: [HIGH_TURN], roles: new RoleBackend(clean) });
		const events = await s.send("add auth");
		const [done] = ofType(events, "review_finished");
		expect(done).toMatchObject({ verdict: "approved", findings: [], correction: null });
		expect(s.main.prompts).toHaveLength(1);
		expect(s.roles.roles).toHaveLength(4);
	});

	it("writes a declined receipt without a model call and does not ask again for the same candidate", async () => {
		const s = await start({ turns: [HIGH_TURN, [{ event: finished }]], consent: "declined" });
		const events = await s.send("add auth");
		expect(s.asked).toHaveLength(1);
		expect(s.roles.roles).toEqual([]);
		expect(ofType(events, "review_finished")[0]).toMatchObject({ verdict: "declined" });
		const stored = await receipts(s.cwd);
		expect(stored).toHaveLength(1);
		expect(stored[0]?.receipt.verdict).toBe("declined");
		const again = await s.send("again");
		expect(types(again).filter((type) => type.startsWith("review_"))).toEqual([]);
		expect(s.asked).toHaveLength(1);
	});

	it("only assesses when nobody can be asked", async () => {
		const s = await start({ turns: [HIGH_TURN], consent: "none" });
		const events = await s.send("add auth");
		expect(ofType(events, "review_assessed")[0]).toMatchObject({ level: "high", reviewDue: true });
		expect(types(events).filter((type) => type.startsWith("review_"))).toEqual(["review_assessed"]);
		expect(s.roles.roles).toEqual([]);
		expect(await receipts(s.cwd)).toEqual([]);
	});

	it("does not offer a candidate that already has a receipt", async () => {
		const s = await start({ turns: [HIGH_TURN, [{ event: finished }]], roles: new RoleBackend(clean) });
		await s.send("add auth");
		const again = await s.send("again");
		expect(types(again).filter((type) => type.startsWith("review_"))).toEqual([]);
		expect(s.asked).toHaveLength(1);
	});

	it("can be interrupted while it waits for the user's answer, leaving no receipt", async () => {
		const s = await start({ turns: [HIGH_TURN], consent: () => new Promise(() => {}) });
		const running = s.send("add auth");
		for (let i = 0; i < 100 && s.asked.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(s.asked).toHaveLength(1);
		await s.session.interrupt();
		const events = await running;
		expect(events.filter((event) => event.type === "turn_finished")).toHaveLength(1);
		expect(s.roles.roles).toEqual([]);
		expect(await receipts(s.cwd)).toEqual([]);
	});
});

describe("Session.review", () => {
	it("says there is nothing to review on a clean worktree", async () => {
		const s = await start();
		const events = await collect(s.session.review("t-1"));
		expect(ofType(events, "error")[0]).toMatchObject({ code: "nothing_to_review", recoverable: true });
		expect(events.filter((event) => event.type === "turn_finished")).toHaveLength(1);
		expect(events.every((event) => event.turnId === "t-1")).toBe(true);
		expect(s.main.prompts).toEqual([]);
	});

	it("reviews a medium-risk change on demand with the one lens, no consent asked", async () => {
		const s = await start({ roles: new RoleBackend(clean) });
		await writeFile(join(s.cwd, "a.ts"), "base\nmore\n");
		const events = await collect(s.session.review());
		expect(s.asked).toEqual([]);
		expect(ofType(events, "review_assessed")[0]).toMatchObject({ level: "medium", reviewDue: false });
		expect(ofType(events, "review_finished")[0]).toMatchObject({ verdict: "approved" });
		expect(s.roles.roles.map((role) => role.role)).toEqual(["reliability"]);
		expect(events.filter((event) => event.type === "turn_finished" && event.agent === undefined)).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", usage: { input: 2, output: 2 } });
	});

	it("reviews a documentation-only change without a model call", async () => {
		const s = await start();
		await writeFile(join(s.cwd, "notes.md"), "# notes\n");
		const events = await collect(s.session.review());
		expect(ofType(events, "review_assessed")[0]).toMatchObject({ level: "passive", lenses: [] });
		expect(ofType(events, "review_finished")[0]).toMatchObject({ verdict: "approved" });
		expect(s.roles.roles).toEqual([]);
		expect(await receipts(s.cwd)).toHaveLength(1);
	});

	it("reviews again, overwriting the receipt, even when the candidate already has one", async () => {
		const s = await start({ roles: new RoleBackend(clean) });
		await writeFile(join(s.cwd, "a.ts"), "base\nmore\n");
		await collect(s.session.review());
		const [first] = await receipts(s.cwd);
		const events = await collect(s.session.review());
		expect(ofType(events, "review_finished")[0]).toMatchObject({ verdict: "approved" });
		expect(s.roles.roles).toHaveLength(2);
		expect(await receipts(s.cwd)).toHaveLength(1);
		expect((await receipts(s.cwd))[0]?.file).toBe(first?.file);
	});

	it("answers review_unavailable outside a git repo, and busy or closed like send", async () => {
		const folder = await mkdtemp(join(tmpdir(), "atelier-review-nogit-"));
		dirs.push(folder);
		const none = await start({ cwd: folder });
		const events = await collect(none.session.review());
		expect(ofType(events, "error")[0]).toMatchObject({ code: "review_unavailable", recoverable: true });
		expect(ofType(events, "error")[0]?.message).toContain("not inside a git repository");
		expect(events.filter((event) => event.type === "turn_finished")).toHaveLength(1);

		const s = await start({ turns: [[{ waitForInterrupt: true }]] });
		const running = s.send("hold");
		await new Promise((resolve) => setTimeout(resolve, 30));
		const busy = await collect(s.session.review());
		expect(ofType(busy, "error")[0]).toMatchObject({ code: "busy" });
		expect(busy.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error" });
		await s.session.interrupt();
		await running;
		await s.session.close();
		const closed = await collect(s.session.review());
		expect(ofType(closed, "error")[0]).toMatchObject({ code: "session_closed" });
	});

	it("stops a running review when the session is interrupted, with no receipt and one turn_finished", async () => {
		const roles = new RoleBackend(() => HOLD);
		const s = await start({ roles });
		await writeFile(join(s.cwd, "a.ts"), "base\nmore\n");
		const running = collect(s.session.review());
		for (let i = 0; i < 100 && roles.roles.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(roles.roles).toHaveLength(1);
		await s.session.interrupt();
		const events = await running;
		expect(roles.interrupts).toBeGreaterThan(0);
		expect(ofType(events, "review_finished")[0]).toMatchObject({ verdict: "unavailable", reason: "interrupted" });
		expect(ofType(events, "review_finished")[0]?.receiptPath).toBeUndefined();
		expect(events.filter((event) => event.type === "turn_finished" && event.agent === undefined)).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "interrupted" });
		expect(await receipts(s.cwd)).toEqual([]);
	});
});

describe("reviewEnabled", () => {
	it("is on unless ATELIER_REVIEW=off", () => {
		expect(reviewEnabled({})).toBe(true);
		expect(reviewEnabled({ ATELIER_REVIEW: "on" })).toBe(true);
		expect(reviewEnabled({ ATELIER_REVIEW: "off" })).toBe(false);
	});
});

describe("RpcServer review", () => {
	interface Wire {
		review?: boolean;
	}
	async function serve(turns: FakeStep[][], wire: Wire = {}) {
		const cwd = await repo();
		const input = new PassThrough();
		const messages: ServerMessage[] = [];
		let created = 0;
		const roles = new RoleBackend();
		const server = new RpcServer({
			input,
			write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
			createBackend: () => (created++ === 0 ? new FakeBackend(turns) : roles),
			tools: [changeTool],
			systemPromptAppend: "",
			...wire,
		});
		const done = server.run();
		let next = 0;
		const send = (command: Record<string, unknown>) => {
			const id = `c${++next}`;
			input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
			return id;
		};
		const waitFor = async (predicate: (m: ServerMessage) => boolean) => {
			for (let i = 0; i < 400; i++) {
				const found = messages.find(predicate);
				if (found) return found;
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			throw new Error(
				`Timed out; got ${JSON.stringify(messages.map((m) => (m.type === "event" ? m.event.type : m.type)))}`,
			);
		};
		const answerOf = async (id: string) =>
			(await waitFor((m) => m.type === "response" && m.id === id)) as Extract<ServerMessage, { type: "response" }>;
		const begin = async (extra: Record<string, unknown> = {}) => {
			const response = await answerOf(send({ command: "session.start", cwd, ...extra }));
			return (response as unknown as { result: { sessionId: string } }).result.sessionId;
		};
		const events = (sessionId: string) =>
			messages.flatMap((m) => (m.type === "event" && m.sessionId === sessionId ? [m.event] : []));
		const eventOf = (type: string) =>
			waitFor((m) => m.type === "event" && m.event.type === type) as Promise<{ event: AtelierEvent }>;
		return { cwd, input, messages, roles, send, answerOf, begin, events, eventOf, waitFor, done };
	}

	it("runs session.review as a streamed turn answered with its turnId", async () => {
		const h = await serve([], { review: true });
		const sessionId = await h.begin();
		await writeFile(join(h.cwd, "notes.md"), "# notes\n");
		const response = await h.answerOf(h.send({ command: "session.review", sessionId }));
		expect(response.ok).toBe(true);
		const turnId = (response as unknown as { result: { turnId: string } }).result.turnId;
		await h.eventOf("review_finished");
		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		const events = h.events(sessionId);
		expect(events.every((event) => event.turnId === turnId)).toBe(true);
		expect(types(events)).toContain("review_assessed");
		expect(events.filter((event) => event.type === "turn_finished")).toHaveLength(1);
	});

	it("asks for consent and continues on session.review_consent, which rejects unknown ids", async () => {
		const h = await serve([HIGH_TURN, [change("src/auth.ts", "export const a = 2;\n"), { event: finished }]], {
			review: true,
		});
		const sessionId = await h.begin();
		h.send({ command: "session.send", sessionId, prompt: "add auth" });
		const { event } = await h.eventOf("review_consent_requested");
		const reviewId = (event as { reviewId: string }).reviewId;

		const unknown = await h.answerOf(
			h.send({ command: "session.review_consent", sessionId, reviewId: "nope", answer: "granted" }),
		);
		expect(unknown).toMatchObject({ ok: false, error: { code: "unknown_review" } });
		const granted = await h.answerOf(
			h.send({ command: "session.review_consent", sessionId, reviewId, answer: "granted" }),
		);
		expect(granted).toMatchObject({ ok: true, result: {} });
		await h.eventOf("review_finished");
		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished" && m.event.agent === undefined);
		expect(ofType(h.events(sessionId), "review_finished")[0]).toMatchObject({ verdict: "approved" });
		const twice = await h.answerOf(
			h.send({ command: "session.review_consent", sessionId, reviewId, answer: "granted" }),
		);
		expect(twice).toMatchObject({ ok: false, error: { code: "unknown_review" } });
	});

	it("records a declined receipt when the user declines", async () => {
		const h = await serve([HIGH_TURN], { review: true });
		const sessionId = await h.begin();
		h.send({ command: "session.send", sessionId, prompt: "add auth" });
		const { event } = await h.eventOf("review_consent_requested");
		h.send({
			command: "session.review_consent",
			sessionId,
			reviewId: (event as { reviewId: string }).reviewId,
			answer: "declined",
		});
		await h.eventOf("review_finished");
		expect(ofType(h.events(sessionId), "review_finished")[0]).toMatchObject({ verdict: "declined" });
		expect(h.roles.roles).toEqual([]);
		expect((await receipts(h.cwd))[0]?.receipt.verdict).toBe("declined");
	});

	it("answers a pending consent as declined when the session closes", async () => {
		const h = await serve([HIGH_TURN], { review: true });
		const sessionId = await h.begin();
		h.send({ command: "session.send", sessionId, prompt: "add auth" });
		await h.eventOf("review_consent_requested");
		await h.answerOf(h.send({ command: "session.close", sessionId }));
		for (let i = 0; i < 200 && (await receipts(h.cwd)).length === 0; i++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		expect((await receipts(h.cwd))[0]?.receipt.verdict).toBe("declined");
	});

	it("gives no review to a session started with review:false, nor when the server has it off", async () => {
		const h = await serve([MEDIUM_TURN], { review: true });
		const sessionId = await h.begin({ review: false });
		h.send({ command: "session.send", sessionId, prompt: "edit" });
		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		expect(types(h.events(sessionId)).filter((type) => type.startsWith("review_"))).toEqual([]);
		await h.answerOf(h.send({ command: "session.review", sessionId }));
		const refused = await h.eventOf("error");
		expect(refused.event).toMatchObject({ code: "review_unavailable" });

		const off = await serve([MEDIUM_TURN], { review: false });
		const offId = await off.begin();
		off.send({ command: "session.send", sessionId: offId, prompt: "edit" });
		await off.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		expect(types(off.events(offId)).filter((type) => type.startsWith("review_"))).toEqual([]);
	});

	it("refuses an explicit review:true when the server has review off", async () => {
		const off = await serve([], { review: false });
		const response = await off.answerOf(off.send({ command: "session.start", cwd: off.cwd, review: true }));
		expect(response).toMatchObject({ ok: false, error: { code: "review_unavailable" } });
		expect(off.messages.filter((m) => m.type === "event")).toEqual([]);
	});

	it("reviews by default when the server has review on", async () => {
		const h = await serve([MEDIUM_TURN], { review: true });
		const sessionId = await h.begin();
		h.send({ command: "session.send", sessionId, prompt: "edit" });
		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		expect(types(h.events(sessionId))).toContain("review_assessed");
	});
});
