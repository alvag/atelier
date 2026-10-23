import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentBackend, BackendSession, BackendStartOptions, ToolCall } from "../src/backend.ts";
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
import { VERIFIER_INSTRUCTION } from "../src/review/verifier.ts";
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

const gitIn = (root: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf8" });

/** The main agent running git in the worktree: commit everything, or any other command. */
const gitTool = defineTool({
	name: "git",
	description: "Runs git",
	inputShape: { args: z.array(z.string()) },
	execute: async ({ args }, { cwd }) => {
		gitIn(cwd, ...args);
		return { ok: true, output: "done", summary: args.join(" "), truncated: false };
	},
});
const commit = (message = "work"): FakeStep[] => [
	call("git", { args: ["add", "-A"] }, `c-add-${message}`),
	call("git", { args: ["commit", "-qm", message] }, `c-commit-${message}`),
];

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
	readonly roles: { role: string; tools: string[]; model?: string; prompt: string; cwd: string }[] = [];
	/** What the tool calls a role made through `probes` answered, in order. */
	readonly probed: { ok: boolean; output: string }[] = [];
	interrupts = 0;
	readonly #reply: (role: string, prompt: string) => Reply;
	readonly #probes: (role: string, prompt: string) => ToolCall[];

	constructor(
		reply: (role: string, prompt: string) => Reply = defaultReply,
		probes: (role: string, prompt: string) => ToolCall[] = () => [],
	) {
		this.#reply = reply;
		this.#probes = probes;
	}

	async start(options: BackendStartOptions): Promise<BackendSession> {
		const role = roleOf(options.systemPromptAppend);
		const reply = this.#reply;
		const roles = this.roles;
		const probed = this.probed;
		const probes = this.#probes;
		const tools = options.tools.map((tool) => tool.name);
		let release: (() => void) | undefined;
		const backend = this;
		return {
			async *send(prompt: string): AsyncIterable<AtelierEventBody> {
				roles.push({
					role,
					tools,
					prompt,
					cwd: options.cwd,
					...(options.model === undefined ? {} : { model: options.model }),
				});
				for (const probe of probes(role, prompt)) {
					const result = await options.executeTool(probe);
					probed.push({ ok: result.ok, output: result.output });
				}
				const answer = reply(role, prompt);
				if (answer === HOLD) {
					await new Promise<void>((resolve) => {
						release = resolve;
					});
					yield { type: "turn_finished", stopReason: "interrupted", usage: { ...usage, input: 2, output: 2 } };
					return;
				}
				yield { type: "text_delta", text: answer };
				yield {
					type: "turn_finished",
					stopReason: "end_turn",
					usage: { ...usage, input: 2, output: 2 },
					requests: 1,
				};
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
	if (instruction === VERIFIER_INSTRUCTION) return "verifier";
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
	if (role === "verifier") return vreport();
	if (role === "refuter")
		return JSON.stringify({ verdicts: idsIn(prompt).map((id) => ({ id, verdict: "confirmed", reason: "it holds" })) });
	if (role === "validator")
		return JSON.stringify({ results: idsIn(prompt).map((id) => ({ id, resolved: true, evidence: "src/auth.ts:1" })) });
	return JSON.stringify({ findings: role === "reliability" ? [{ lens: role, ...severe }] : [] });
}
const clean = (role: string, prompt: string) =>
	role === "refuter" || role === "validator" || role === "verifier"
		? defaultReply(role, prompt)
		: JSON.stringify({ findings: [] });

const vrequirement = { id: "R1", requirement: "the approval needs a keypress", verdict: "met", evidence: "ran it" };
const vdefect = (over: Record<string, unknown> = {}) => ({
	id: "D1",
	severity: "blocker",
	summary: "A pasted y approves the command",
	reproduction: "printf 'ls\\ny' | node cli.ts",
	candidate: "ran ls",
	base: "asked again",
	onBase: false,
	...over,
});
/** A verifier report; clean unless given defects. */
const vreport = (defects: unknown[] = [], requirements: unknown[] = [vrequirement]) =>
	JSON.stringify({ requirements, defects });
/** The verifier's reply by round (the last one repeats); every other role answers as by default. */
const verifying = (...reports: string[]) =>
	(() => {
		let round = 0;
		return (role: string, prompt: string): Reply =>
			role === "verifier" ? (reports[Math.min(round++, reports.length - 1)] as string) : defaultReply(role, prompt);
	})();

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
		tools: [changeTool, gitTool],
		...(setup.review === false
			? {}
			: { review: { createBackend: () => roles, ...(consent ? { consent: consent as never } : {}) } }),
		...setup.extra,
	});
	return { session, main, roles, cwd, asked, send: (prompt: string) => collect(session.send(prompt)) };
}

const DECLARED_NONE = call("risk", { none: true, reason: "test" });
const HIGH_TURN: FakeStep[] = [
	DECLARED_NONE,
	change("src/auth.ts", "export const a = 1;\n"),
	text("done"),
	{ event: finished },
];
const MEDIUM_TURN: FakeStep[] = [change("a.ts", "base\nmore\n"), text("done"), { event: finished }];

describe("the risk tool", () => {
	it("exists only when review is on, with its short rule in the system prompt", async () => {
		const on = await start({ turns: [[{ event: finished }]] });
		expect(on.main.startOptions?.tools.map((tool) => tool.name)).toContain("risk");
		expect(on.main.startOptions?.systemPromptAppend).toContain(RISK_RULES);
		expect(Buffer.byteLength(RISK_RULES)).toBeLessThanOrEqual(1800);
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

describe("the risk declaration", () => {
	const ASK =
		"Declare the risk of this change now: call the risk tool with the high-risk items that apply and a reason, or with none and a reason.";
	const declareNone = call("risk", { none: true, reason: "a one-line tweak, nothing shares it" });
	const UNDECLARED_HIGH: FakeStep[] = [
		change("src/auth.ts", "export const a = 1;\n"),
		text("done"),
		{ event: finished },
	];

	it("tells the agent to close every code change with its risk, with the six items", async () => {
		const s = await start({ turns: [[{ event: finished }]] });
		const prompt = s.main.startOptions?.systemPromptAppend ?? "";
		expect(prompt).toContain("declaring its risk with the risk tool");
		expect(prompt).toContain("or none with a reason");
		for (const item of [
			"1. data that cannot be rebuilt or irreversible effects (migrations, rewriting or deleting existing records; not saving new records, caches or generated files)",
			"2. security (auth, permissions, credentials, secrets, guards, sandbox)",
			"3. changing or removing contracts others already consume (public API, CLI flags, config formats, exports; not adding a flag, command or optional field)",
			"4. concurrency",
			"5. delivery or environment (installers, release, CI, deploy, dependencies)",
			"6. no test would catch a regression in what changes",
		])
			expect(prompt).toContain(item);
		expect(prompt).toContain(
			"Before declaring none, check whether the change touches code that existing behavior also uses (shared options, parsers, helpers).",
		);
	});

	it("shows a declared none with its reason and does not ask again", async () => {
		const s = await start({ turns: [[declareNone, ...MEDIUM_TURN]] });
		const events = await s.send("edit");
		expect(s.main.prompts).toHaveLength(1);
		expect(ofType(events, "review_assessed")[0]).toMatchObject({
			level: "medium",
			reasons: ["code change without a high-risk signal"],
			declaration: { kind: "none", reason: "a one-line tweak, nothing shares it" },
		});
	});

	it("never lowers what the automatic check finds: none on a high-risk change stays high", async () => {
		const s = await start({ turns: [[declareNone, ...UNDECLARED_HIGH]], consent: "declined" });
		const events = await s.send("add auth");
		expect(ofType(events, "review_assessed")[0]).toMatchObject({
			level: "high",
			reviewDue: true,
			declaration: { kind: "none" },
		});
	});

	it("S6: a change that only sets the terminal's raw mode stays medium with its declaration", async () => {
		const turn = [
			declareNone,
			change("src/term.ts", "process.stdin.setRawMode(true);\n"),
			text("done"),
			{ event: finished },
		];
		const s = await start({ turns: [turn] });
		const events = await s.send("raw mode");
		expect(ofType(events, "review_assessed")[0]).toMatchObject({
			level: "medium",
			reviewDue: false,
			reasons: ["code change without a high-risk signal"],
			declaration: { kind: "none" },
		});
	});

	it("S6: a real process spawn is high with its place, a spawn in a comment is not", async () => {
		const real = [
			declareNone,
			change("src/run.ts", 'import { x } from "./x";\nconst child = spawn("stty");\n'),
			text("done"),
			{ event: finished },
		];
		const spawned = await start({ turns: [real], consent: "declined" });
		expect(ofType(await spawned.send("run"), "review_assessed")[0]).toMatchObject({
			level: "high",
			reasons: ["shell_process: src/run.ts:2"],
		});
		const commented = [
			declareNone,
			change("src/run.ts", '// const cp = require("child_process");\n'),
			text("done"),
			{ event: finished },
		];
		const quiet = await start({ turns: [commented] });
		expect(ofType(await quiet.send("run"), "review_assessed")[0]).toMatchObject({ level: "medium" });
	});

	it("shows declared items with their reason", async () => {
		const s = await start({
			turns: [[call("risk", { items: [2], reason: "handles sessions" }), ...MEDIUM_TURN]],
			consent: "declined",
		});
		const events = await s.send("edit");
		expect(s.main.prompts).toHaveLength(1);
		expect(ofType(events, "review_assessed")[0]).toMatchObject({
			level: "high",
			declaration: { kind: "items", items: [{ items: [2], reason: "handles sessions" }] },
		});
	});

	it("asks once, inside the turn, when a code change has no declaration; the answer counts", async () => {
		const turns = [MEDIUM_TURN, [declareNone, text("declared"), { event: finished }]];
		const s = await start({ turns });
		const events = await s.send("edit");
		expect(s.main.prompts).toEqual(["edit", ASK]);
		expect(ofType(events, "review_assessed")).toHaveLength(1);
		expect(ofType(events, "review_assessed")[0]).toMatchObject({ declaration: { kind: "none" } });
		expect(events.filter((event) => event.type === "turn_finished")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", usage: { input: 2, output: 2 } });
	});

	it("does not loop: a second silence ends in a medium risk marked without declaration", async () => {
		const s = await start({ turns: [MEDIUM_TURN, [text("ok"), { event: finished }], [text("never")]] });
		const events = await s.send("edit");
		expect(s.main.prompts).toEqual(["edit", ASK]);
		expect(ofType(events, "review_assessed")[0]).toMatchObject({
			level: "medium",
			reasons: ["code change; no risk declaration"],
			lenses: ["reliability"],
			reviewDue: false,
			declaration: { kind: "missing" },
		});
	});

	it("keeps a high risk high and says the declaration is missing", async () => {
		const s = await start({ turns: [UNDECLARED_HIGH, [{ event: finished }]], consent: "declined" });
		const events = await s.send("add auth");
		const [assessed] = ofType(events, "review_assessed");
		expect(assessed).toMatchObject({ level: "high", reviewDue: true, declaration: { kind: "missing" } });
		expect(assessed?.reasons.at(-1)).toBe("no risk declaration");
	});

	it("does not ask about documentation-only changes, nor on demand", async () => {
		const docs = await start({ turns: [[change("notes.md", "# notes\n"), text("done"), { event: finished }]] });
		const events = await docs.send("write notes");
		expect(docs.main.prompts).toEqual(["write notes"]);
		const [assessed] = ofType(events, "review_assessed");
		expect(assessed).toMatchObject({ level: "passive" });
		expect(assessed?.declaration).toBeUndefined();

		const manual = await start({ roles: new RoleBackend(clean) });
		await writeFile(join(manual.cwd, "a.ts"), "base\nmore\n");
		await collect(manual.session.review());
		expect(manual.main.prompts).toEqual([]);
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
		// The roles' model requests count too: 4 lenses, the refuter and the validator.
		expect(last?.type === "turn_finished" && last.requests).toBe(6);
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
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", usage: { input: 2, output: 2 }, requests: 1 });
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

	it("gives no review to a session started with review:false, nor when the server has it off, and says so once", async () => {
		const h = await serve([MEDIUM_TURN], { review: true });
		const sessionId = await h.begin({ review: false });
		h.send({ command: "session.send", sessionId, prompt: "edit" });
		await h.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		expect(h.events(sessionId).filter((event) => event.type.startsWith("review_"))).toMatchObject([
			{ type: "review_status", available: false, reason: "Review is off for this session." },
		]);
		await h.answerOf(h.send({ command: "session.review", sessionId }));
		const refused = await h.eventOf("error");
		expect(refused.event).toMatchObject({ code: "review_unavailable" });

		const off = await serve([MEDIUM_TURN], { review: false });
		const offId = await off.begin();
		off.send({ command: "session.send", sessionId: offId, prompt: "edit" });
		await off.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		expect(off.events(offId).filter((event) => event.type.startsWith("review_"))).toMatchObject([
			{ type: "review_status", available: false, reason: "Review is off on this server (ATELIER_REVIEW=off)." },
		]);
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

describe("the turn's candidate", () => {
	const TERMINAL = "export const input = 1;\n";

	it("reviews code the turn committed, not only what is left uncommitted (run 4)", async () => {
		const cwd = await repo();
		const from = gitIn(cwd, "rev-parse", "HEAD").trim();
		const turn = [
			DECLARED_NONE,
			change("src/terminal-input.ts", TERMINAL),
			...commit("add the terminal reader"),
			text("done"),
			{ event: finished },
		];
		const s = await start({ cwd, turns: [turn] });
		const events = await s.send("write the reader");
		const [assessed] = ofType(events, "review_assessed");
		expect(assessed).toMatchObject({ level: "medium", files: ["src/terminal-input.ts"], lenses: ["reliability"] });
		expect(assessed?.reasons).not.toContain("no changes");
		expect(assessed?.since).toBe(from.slice(0, 7));
		expect(assessed?.baseNote).toBeUndefined();
	});

	it("reviews the commits and the uncommitted edits of the turn together", async () => {
		const cwd = await repo();
		const turn = [
			DECLARED_NONE,
			change("src/one.ts", "export const one = 1;\n"),
			...commit("one"),
			change("src/two.ts", "export const two = 2;\n"),
			text("done"),
			{ event: finished },
		];
		const s = await start({ cwd, turns: [turn] });
		const [assessed] = ofType(await s.send("go"), "review_assessed");
		expect([...(assessed?.files ?? [])].sort()).toEqual(["src/one.ts", "src/two.ts"]);
	});

	it("shows no base when the turn committed nothing", async () => {
		const s = await start({ turns: [[DECLARED_NONE, ...MEDIUM_TURN]] });
		const [assessed] = ofType(await s.send("edit"), "review_assessed");
		expect(assessed?.since).toBeUndefined();
	});

	it("uses the current HEAD and says so when HEAD no longer descends from where the turn started", async () => {
		const cwd = await repo();
		await writeFile(join(cwd, "b.ts"), "second\n");
		gitIn(cwd, "add", "-A");
		gitIn(cwd, "commit", "-qm", "second");
		const from = gitIn(cwd, "rev-parse", "HEAD").trim();
		const turn = [
			DECLARED_NONE,
			call("git", { args: ["reset", "-q", "--hard", "HEAD~1"] }),
			change("a.ts", "base\nmore\n"),
			text("done"),
			{ event: finished },
		];
		const s = await start({ cwd, turns: [turn] });
		const [assessed] = ofType(await s.send("rewind"), "review_assessed");
		expect(assessed?.files).toEqual(["a.ts"]);
		expect(assessed?.since).toBeUndefined();
		expect(assessed?.baseNote).toBe(
			`HEAD no longer descends from ${from.slice(0, 7)}, where the turn started: the base is the current HEAD`,
		);
	});

	it("does not offer the same candidate twice when a later turn commits it unchanged", async () => {
		const cwd = await repo();
		const turns = [HIGH_TURN, [text("committing"), ...commit("auth"), { event: finished }]];
		const s = await start({ cwd, turns, roles: new RoleBackend(clean) });
		await s.send("add auth");
		expect(s.asked).toHaveLength(1);
		const second = await s.send("commit it");
		expect(s.asked).toHaveLength(1);
		expect(ofType(second, "review_consent_requested")).toEqual([]);
		expect(await receipts(cwd)).toHaveLength(1);
	});
});

describe("the declaration of a turn", () => {
	const ASK =
		"Declare the risk of this change now: call the risk tool with the high-risk items that apply and a reason, or with none and a reason.";

	it("does not carry over: a none from an earlier turn never covers a later turn's code", async () => {
		// The first turn declares and changes nothing, so its declaration is never consumed by a review.
		const turns = [
			[call("risk", { none: true, reason: "docs only" }), text("nothing to do"), { event: finished }],
			MEDIUM_TURN,
			[text("no declaration"), { event: finished }],
		];
		const s = await start({ turns });
		await s.send("look");
		const events = await s.send("edit");
		expect(s.main.prompts.at(-1)).toBe(ASK);
		expect(ofType(events, "review_assessed")[0]).toMatchObject({ declaration: { kind: "missing" } });
	});

	it("does not carry over escalations either", async () => {
		const turns = [
			[call("risk", { items: [2], reason: "sessions" }), text("nothing to do"), { event: finished }],
			[DECLARED_NONE, ...MEDIUM_TURN],
		];
		const s = await start({ turns });
		await s.send("look");
		const [assessed] = ofType(await s.send("edit"), "review_assessed");
		expect(assessed).toMatchObject({ level: "medium", declaration: { kind: "none" } });
	});

	it("keeps a declaration for the review of its own turn", async () => {
		const s = await start({ turns: [[call("risk", { items: [2], reason: "sessions" }), ...MEDIUM_TURN]] });
		const [assessed] = ofType(await s.send("edit"), "review_assessed");
		expect(assessed).toMatchObject({ level: "high", declaration: { kind: "items" } });
	});

	it("freezes the candidate again after the ask: edits made while answering are assessed", async () => {
		const turns = [
			MEDIUM_TURN,
			[DECLARED_NONE, change("src/auth.ts", "export const a = 1;\n"), text("declared"), { event: finished }],
		];
		const s = await start({ turns, consent: "declined" });
		const events = await s.send("edit");
		expect(s.main.prompts.at(-1)).toBe(ASK);
		const assessed = ofType(events, "review_assessed");
		expect(assessed).toHaveLength(1);
		expect([...(assessed[0]?.files ?? [])].sort()).toEqual(["a.ts", "src/auth.ts"]);
		expect(assessed[0]).toMatchObject({ level: "high", reviewDue: true, declaration: { kind: "none" } });
		expect(s.asked).toHaveLength(1);
		expect((await receipts(s.cwd)).map(({ file }) => file)).toEqual([`${assessed[0]?.tree}.json`]);
	});

	it("stops quietly when the answer to the ask undoes the change", async () => {
		const turns = [MEDIUM_TURN, [DECLARED_NONE, change("a.ts", "base\n"), text("reverted"), { event: finished }]];
		const s = await start({ turns });
		const events = await s.send("edit");
		expect(ofType(events, "review_assessed")).toEqual([]);
		expect(events.at(-1)?.type).toBe("turn_finished");
	});
});

describe("/review against a ref", () => {
	it("freezes the worktree against the ref's tree", async () => {
		const cwd = await repo();
		await mkdir(join(cwd, "src"), { recursive: true });
		await writeFile(join(cwd, "src/old.ts"), "old\n");
		gitIn(cwd, "add", "-A");
		gitIn(cwd, "commit", "-qm", "second");
		await writeFile(join(cwd, "a.ts"), "base\nmore\n");
		const s = await start({ cwd, roles: new RoleBackend(clean) });
		const events = await collect(s.session.review(undefined, "HEAD~1"));
		const [assessed] = ofType(events, "review_assessed");
		expect([...(assessed?.files ?? [])].sort()).toEqual(["a.ts", "src/old.ts"]);
		expect(assessed?.since).toBe(gitIn(cwd, "rev-parse", "HEAD~1").trim().slice(0, 7));
		expect(ofType(events, "review_finished")[0]).toMatchObject({ verdict: "approved" });
	});

	it("refuses an unknown ref and reviews nothing", async () => {
		const s = await start({ roles: new RoleBackend(clean) });
		const events = await collect(s.session.review(undefined, "no-such-ref"));
		expect(events.find((event) => event.type === "error")).toMatchObject({
			code: "review_unavailable",
			message: 'Unknown git ref "no-such-ref": there is nothing to review against.',
			recoverable: true,
		});
		expect(ofType(events, "review_assessed")).toEqual([]);
		expect(s.roles.roles).toEqual([]);
		expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "error" });
	});

	it("does not take an option for a ref", async () => {
		const s = await start({ roles: new RoleBackend(clean) });
		const events = await collect(s.session.review(undefined, "--help"));
		expect(events.find((event) => event.type === "error")).toMatchObject({ code: "review_unavailable" });
	});

	it("keeps reviewing against HEAD without a ref", async () => {
		const cwd = await repo();
		await writeFile(join(cwd, "a.ts"), "base\nmore\n");
		const s = await start({ cwd, roles: new RoleBackend(clean) });
		const [assessed] = ofType(await collect(s.session.review()), "review_assessed");
		expect(assessed?.files).toEqual(["a.ts"]);
		expect(assessed?.since).toBeUndefined();
	});
});

describe("independent verification", () => {
	const DECLARED = call("risk", { items: [2], reason: "guards the bash approval" });
	const VERIFY_TURN: FakeStep[] = [DECLARED, change("a.ts", "base\ncandidate\n"), text("done"), { event: finished }];
	const FIX_TURN: FakeStep[] = [change("a.ts", "base\nfixed\n"), text("fixed"), { event: finished }];
	const verifierRuns = (roles: RoleBackend) => roles.roles.filter((role) => role.role === "verifier");
	const verification = (events: AtelierEvent[]) =>
		events.filter((event) => event.type.startsWith("verification_")).map((event) => event.type);
	const bash = (command: string): ToolCall => ({ tool: "bash", input: { command }, callId: `p-${command.length}` });
	const probing =
		(...commands: string[]) =>
		(role: string) =>
			role === "verifier" ? commands.map(bash) : [];

	describe("when it runs", () => {
		it("runs on a declared high-risk item, before the review, and does not ask for consent", async () => {
			const roles = new RoleBackend(verifying(vreport()));
			const s = await start({ turns: [VERIFY_TURN], roles, consent: "declined" });
			const events = await s.send("make the approval need a keypress");
			expect(verifierRuns(roles)).toHaveLength(1);
			expect(verification(events)).toEqual(["verification_started", "verification_round", "verification_finished"]);
			const finishedAt = events.findIndex((event) => event.type === "verification_finished");
			expect(finishedAt).toBeGreaterThan(-1);
			expect(finishedAt).toBeLessThan(events.findIndex((event) => event.type === "review_assessed"));
			// The only question the user got is the review's.
			expect(s.asked).toHaveLength(1);
			expect(ofType(events, "review_consent_requested")).toHaveLength(1);
			expect(events.filter((event) => event.type === "turn_finished" && event.agent === undefined)).toHaveLength(1);
		});

		it.each([
			["declared none", [call("risk", { none: true, reason: "x" }), change("a.ts", "base\nmore\n")]],
			["no declaration", [change("a.ts", "base\nmore\n")]],
			["a native-only high", [DECLARED_NONE, change("src/auth.ts", "export const a = 1;\n")]],
		])("does not run for %s", async (_name, work) => {
			const roles = new RoleBackend();
			const s = await start({
				turns: [[...work, text("done"), { event: finished }], [{ event: finished }]],
				roles,
				consent: "declined",
			});
			const events = await s.send("edit");
			expect(verifierRuns(roles)).toEqual([]);
			expect(verification(events)).toEqual([]);
		});

		it("does not run for an on-demand review, nor when review is off", async () => {
			const roles = new RoleBackend(clean);
			const s = await start({ roles });
			await writeFile(join(s.cwd, "a.ts"), "base\nmore\n");
			expect(verification(await collect(s.session.review()))).toEqual([]);
			expect(verifierRuns(roles)).toEqual([]);

			const off = await start({ review: false, turns: [VERIFY_TURN] });
			expect(verification(await off.send("edit"))).toEqual([]);
		});
	});

	describe("where it works", () => {
		it("gets read, grep and bash, in a temporary directory that holds the candidate and the base, removed afterwards", async () => {
			const roles = new RoleBackend(
				verifying(vreport()),
				probing("cat candidate/a.ts; echo ---; cat base/a.ts; ls -A candidate | tr '\\n' ' '"),
			);
			const s = await start({ turns: [VERIFY_TURN], roles, consent: "declined" });
			await s.send("edit");
			const [run] = verifierRuns(roles);
			expect(run?.tools).toEqual(["read", "grep", "bash"]);
			expect(basename(run?.cwd ?? "")).toMatch(/^atelier-verify-/);
			expect(run?.cwd).not.toBe(s.cwd);
			expect(roles.probed[0]?.output).toContain("base\ncandidate\n---\nbase\n");
			expect(roles.probed[0]?.output).not.toContain(".git");
			await expect(stat(run?.cwd ?? "")).rejects.toThrow();
		});

		it("never touches the user's worktree, index or refs", async () => {
			const roles = new RoleBackend(
				verifying(vreport()),
				probing("echo scratch > scratch.txt; echo more >> candidate/a.ts"),
			);
			const s = await start({ turns: [VERIFY_TURN], roles, consent: "declined" });
			const state = async () => ({
				index: (await readFile(join(s.cwd, ".git", "index"))).toString("base64"),
				refs: gitIn(s.cwd, "for-each-ref") + gitIn(s.cwd, "rev-parse", "HEAD"),
			});
			const before = await state();
			await s.send("edit");
			expect(await state()).toEqual(before);
			expect(await readFile(join(s.cwd, "a.ts"), "utf8")).toBe("base\ncandidate\n");
			expect(await stat(join(s.cwd, "scratch.txt")).catch(() => undefined)).toBeUndefined();
		});

		it("links the project's installed dependencies into the copy and tells the verifier", async () => {
			const cwd = await repo();
			await writeFile(join(cwd, ".gitignore"), "node_modules\n");
			await mkdir(join(cwd, "node_modules/dep"), { recursive: true });
			await writeFile(join(cwd, "node_modules/dep/index.js"), "installed\n");
			gitIn(cwd, "add", "-A");
			gitIn(cwd, "commit", "-qm", "ignore");
			const roles = new RoleBackend(verifying(vreport()), probing("cat candidate/node_modules/dep/index.js"));
			const s = await start({ cwd, turns: [VERIFY_TURN], roles, consent: "declined" });
			await s.send("edit");
			expect(roles.probed[0]?.output).toContain("installed");
			expect(verifierRuns(roles)[0]?.prompt).toContain("installed dependencies are copied");
		});

		it("is removed when the verifier fails and when the turn is interrupted", async () => {
			const failing = new RoleBackend((role, prompt) => {
				if (role === "verifier") throw new Error("boom");
				return defaultReply(role, prompt);
			});
			const s = await start({ turns: [VERIFY_TURN], roles: failing, consent: "declined" });
			await s.send("edit");
			await expect(stat(verifierRuns(failing)[0]?.cwd ?? "")).rejects.toThrow();

			const held = new RoleBackend(() => HOLD);
			const h = await start({ turns: [VERIFY_TURN], roles: held, consent: "declined" });
			const running = h.send("edit");
			for (let i = 0; i < 200 && held.roles.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
			await h.session.interrupt();
			const events = await running;
			await expect(stat(held.roles[0]?.cwd ?? "")).rejects.toThrow();
			expect(ofType(events, "verification_finished")[0]).toMatchObject({ outcome: "failed", reason: "interrupted" });
			expect(ofType(events, "review_assessed")).toEqual([]);
		});
	});

	describe("what it may do", () => {
		it("runs bash without asking, with the filtered environment and package managers kept offline", async () => {
			const previous = process.env.ANTHROPIC_API_KEY;
			process.env.ANTHROPIC_API_KEY = "sk-secret";
			try {
				const roles = new RoleBackend(
					verifying(vreport()),
					probing(
						'echo "[$npm_config_offline][$NO_UPDATE_NOTIFIER][$ANTHROPIC_API_KEY]"; echo "[$npm_config_registry]"',
					),
				);
				const approvals: unknown[] = [];
				const s = await start({
					turns: [VERIFY_TURN],
					roles,
					consent: "declined",
					extra: {
						approve: async (request) => {
							approvals.push(request);
							return false;
						},
					},
				});
				const events = await s.send("edit");
				expect(roles.probed[0]).toMatchObject({ ok: true });
				expect(roles.probed[0]?.output).toContain("[true][1][]");
				expect(roles.probed[0]?.output).toMatch(/\[http:\/\/127\.0\.0\.1:\d+\/?\]/);
				expect(approvals).toEqual([]);
				expect(ofType(events, "approval_requested")).toEqual([]);
			} finally {
				if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
				else process.env.ANTHROPIC_API_KEY = previous;
			}
		});

		it("gets its mandate as instructions and the request, the declaration and the feature document as its prompt", async () => {
			const START = {
				action: "start",
				name: "approvals",
				title: "Approvals",
				header: "Make approvals need a keypress.",
				specs: ['User, verbatim: "que la aprobación pida una tecla"'],
				tasks: [{ title: "Read the key", specs: ["S1"], route: "inline" }],
			};
			const roles = new RoleBackend(verifying(vreport()), probing("cat feature/approvals.md"));
			const s = await start({
				turns: [[call("feature", START), ...VERIFY_TURN]],
				roles,
				consent: "declined",
				extra: { odd: true },
			});
			await s.send("que la aprobación pida una tecla");
			const [run] = verifierRuns(roles);
			expect(run?.prompt).toContain("<request>\nque la aprobación pida una tecla\n</request>");
			expect(run?.prompt).toContain("- item 2: guards the bash approval");
			expect(run?.prompt).toContain("feature/approvals.md");
			expect(roles.probed[0]?.output).toContain("Approvals");
		});
	});

	describe("rounds", () => {
		it("hands blocking defects to the agent once, freezes the corrected work, and verifies again", async () => {
			const roles = new RoleBackend(verifying(vreport([vdefect()]), vreport()), probing("cat candidate/a.ts"));
			const s = await start({ turns: [VERIFY_TURN, FIX_TURN], roles, consent: "declined" });
			const events = await s.send("edit");
			expect(s.main.prompts).toHaveLength(2);
			expect(s.main.prompts[1]).toContain("- D1 [blocker] A pasted y approves the command");
			expect(s.main.prompts[1]).toContain("reproduce: printf");
			expect(verifierRuns(roles)).toHaveLength(2);
			expect(verifierRuns(roles)[1]?.prompt).toContain("Round 2 of 2.");
			expect(verifierRuns(roles)[1]?.prompt).toContain("- D1 [blocker] A pasted y approves the command");
			expect(roles.probed.map((p) => p.output)).toEqual(
				["base\ncandidate\n", "base\nfixed\n"].map((t) => expect.stringContaining(t)),
			);
			const rounds = ofType(events, "verification_round");
			expect(rounds.map((r) => [r.round, r.ok, r.blocking, r.correcting])).toEqual([
				[1, true, ["D1"], true],
				[2, true, [], false],
			]);
			expect(rounds[0]?.defects[0]).toMatchObject({ id: "D1", severity: "blocker", onBase: false });
			expect(rounds[0]?.requirements[0]).toMatchObject({ id: "R1", verdict: "met" });
			expect(ofType(events, "verification_finished")[0]).toMatchObject({
				outcome: "corrected",
				rounds: 2,
				openDefects: [],
			});
			expect(events.filter((event) => event.type === "turn_finished" && event.agent === undefined)).toHaveLength(1);
		});

		it("hands an unmet requirement to the agent like a blocking defect, with its evidence", async () => {
			const unmet = { ...vrequirement, verdict: "unmet", evidence: "a pasted y still approved it" };
			const roles = new RoleBackend(verifying(vreport([], [unmet]), vreport()));
			const s = await start({ turns: [VERIFY_TURN, FIX_TURN], roles, consent: "declined" });
			const events = await s.send("edit");
			expect(s.main.prompts).toHaveLength(2);
			expect(s.main.prompts[1]).toContain("- R1 [blocker] Requirement not met: the approval needs a keypress");
			expect(s.main.prompts[1]).toContain("a pasted y still approved it");
			expect(ofType(events, "verification_round")[0]).toMatchObject({ blocking: ["R1"], correcting: true });
			expect(ofType(events, "verification_finished")[0]).toMatchObject({ outcome: "corrected", rounds: 2 });
		});

		it("keeps an unmet requirement open after round 2 as a decision for the user", async () => {
			const unmet = { ...vrequirement, verdict: "unmet", evidence: "still approves" };
			const roles = new RoleBackend(verifying(vreport([], [unmet])));
			const s = await start({ turns: [VERIFY_TURN, FIX_TURN], roles, consent: "declined" });
			const events = await s.send("edit");
			expect(ofType(events, "verification_finished")[0]).toMatchObject({
				outcome: "needs_decision",
				openDefects: [{ id: "R1", severity: "blocker", reproduction: "still approves" }],
			});
		});

		it("needs the user's decision, listing them, when a requirement stays unverified, even if the rest is met", async () => {
			const unverified = { ...vrequirement, id: "R2", verdict: "unverified", evidence: "no dependencies to run it" };
			const roles = new RoleBackend(verifying(vreport([], [vrequirement, unverified])));
			const s = await start({ turns: [VERIFY_TURN, [text("never")]], roles, consent: "declined" });
			const events = await s.send("edit");
			expect(verifierRuns(roles)).toHaveLength(1);
			expect(ofType(events, "verification_finished")[0]).toMatchObject({
				outcome: "needs_decision",
				reason: "1 unverified requirement: R2 the approval needs a keypress (no dependencies to run it)",
				openDefects: [],
			});
		});

		it("ends needing the user's decision when defects remain after round 2, without a third round", async () => {
			const roles = new RoleBackend(
				verifying(vreport([vdefect()]), vreport([vdefect({ id: "D2", severity: "major" })])),
			);
			const s = await start({ turns: [VERIFY_TURN, FIX_TURN, [text("never")]], roles, consent: "declined" });
			const events = await s.send("edit");
			expect(verifierRuns(roles)).toHaveLength(2);
			expect(s.main.prompts).toHaveLength(2);
			expect(ofType(events, "verification_round")[1]?.correcting).toBe(false);
			expect(ofType(events, "verification_finished")[0]).toMatchObject({
				outcome: "needs_decision",
				rounds: 2,
				openDefects: [{ id: "D2", severity: "major" }],
			});
			expect(events.at(-1)).toMatchObject({ type: "turn_finished", stopReason: "end_turn" });
		});

		it("passes when the defects are minor or also on the base, advisory only", async () => {
			const roles = new RoleBackend(
				verifying(vreport([vdefect({ id: "D1", onBase: true }), vdefect({ id: "D2", severity: "minor" })])),
			);
			const s = await start({ turns: [VERIFY_TURN, [text("never")]], roles, consent: "declined" });
			const events = await s.send("edit");
			expect(s.main.prompts).toHaveLength(1);
			expect(ofType(events, "verification_round")[0]).toMatchObject({ blocking: [], correcting: false });
			expect(ofType(events, "verification_round")[0]?.defects).toHaveLength(2);
			expect(ofType(events, "verification_finished")[0]).toMatchObject({
				outcome: "passed",
				rounds: 1,
				openDefects: [],
			});
		});

		it.each([
			["a reply that is not a report", "looks fine to me"],
			["a report missing a reproduction", vreport([vdefect({ reproduction: "" })])],
		])("is a failed verifier, never a pass, for %s", async (_name, reply) => {
			const roles = new RoleBackend(verifying(reply));
			const s = await start({ turns: [VERIFY_TURN, [text("never")]], roles, consent: "declined" });
			const events = await s.send("edit");
			expect(s.main.prompts).toHaveLength(1);
			expect(ofType(events, "verification_round")[0]).toMatchObject({ round: 1, ok: false });
			expect(ofType(events, "verification_round")[0]?.error).toBeTruthy();
			expect(ofType(events, "verification_finished")[0]).toMatchObject({ outcome: "failed", rounds: 1 });
			expect(ofType(events, "verification_finished")[0]?.reason).toBeTruthy();
		});

		it("fails when the verifier cannot run, and needs a decision when the correction fails", async () => {
			const crashing = new RoleBackend((role, prompt) => {
				if (role === "verifier") throw new Error("model down");
				return defaultReply(role, prompt);
			});
			const a = await start({ turns: [VERIFY_TURN], roles: crashing, consent: "declined" });
			const failed = ofType(await a.send("edit"), "verification_finished")[0];
			expect(failed).toMatchObject({ outcome: "failed" });
			expect(failed?.reason).toContain("model down");

			const roles = new RoleBackend(verifying(vreport([vdefect()])));
			const b = await start({ turns: [VERIFY_TURN, [{ throw: "boom" }]], roles, consent: "declined" });
			const events = await b.send("edit");
			expect(verifierRuns(roles)).toHaveLength(1);
			expect(ofType(events, "verification_finished")[0]).toMatchObject({
				outcome: "needs_decision",
				reason: "The correction failed.",
				openDefects: [{ id: "D1" }],
			});
		});
	});

	describe("before the review, on the final candidate", () => {
		it("assesses and offers for review the corrected candidate, with a receipt for it", async () => {
			const roles = new RoleBackend(verifying(vreport([vdefect()]), vreport()));
			const s = await start({ turns: [VERIFY_TURN, FIX_TURN], roles, consent: "declined" });
			const events = await s.send("edit");
			const [assessed] = ofType(events, "review_assessed");
			expect(assessed).toMatchObject({ level: "high", reviewDue: true });
			expect(gitIn(s.cwd, "show", `${assessed?.tree}:a.ts`)).toBe("base\nfixed\n");
			expect(await readFile(join(s.cwd, "a.ts"), "utf8")).toBe("base\nfixed\n");
			expect(s.asked).toHaveLength(1);
			expect((await receipts(s.cwd)).map(({ file }) => file)).toEqual([`${assessed?.tree}.json`]);
		});

		it("skips the review when the correction undoes the whole change", async () => {
			const roles = new RoleBackend(verifying(vreport([vdefect()]), vreport()));
			const s = await start({
				turns: [VERIFY_TURN, [change("a.ts", "base\n"), text("reverted"), { event: finished }]],
				roles,
			});
			const events = await s.send("edit");
			expect(ofType(events, "verification_finished")[0]).toMatchObject({ outcome: "corrected" });
			expect(ofType(events, "review_assessed")).toEqual([]);
			expect(s.asked).toEqual([]);
		});
	});

	describe("events", () => {
		it("describes the start, each round and the end, and adds the cost to the turn", async () => {
			const roles = new RoleBackend(verifying(vreport([vdefect()]), vreport()));
			const s = await start({ turns: [VERIFY_TURN, FIX_TURN], roles, consent: "declined" });
			const events = await s.send("edit");
			const [started] = ofType(events, "verification_started");
			expect(started).toMatchObject({ items: [2], declaration: [{ items: [2], reason: "guards the bash approval" }] });
			const verifyId = started?.verifyId;
			expect(verifyId).toBeTruthy();
			const [one, two] = ofType(events, "verification_round");
			expect([one?.verifyId, two?.verifyId]).toEqual([verifyId, verifyId]);
			expect(one?.usage).toEqual({ input: 2, output: 2, cacheRead: 0, cacheWrite: 0 });
			const [done] = ofType(events, "verification_finished");
			expect(done?.verifyId).toBe(verifyId);
			// Two verifier runs and one correction turn.
			expect(done?.usage).toEqual({ input: 5, output: 5, cacheRead: 0, cacheWrite: 0 });
			expect(events.at(-1)).toMatchObject({ type: "turn_finished", usage: { input: 6, output: 6 }, requests: 2 });
			// The verifier's own events are nested under the verification.
			const nested = events.filter((event) => event.parentCallId === verifyId);
			expect(nested.length).toBeGreaterThan(0);
			expect(nested.every((event) => event.agent === "verify:verifier")).toBe(true);
		});
	});
});

describe("independent M9 specification probes", () => {
	it("S4 re-freezes the base as well as the tree after asking for a declaration", async () => {
		const cwd = await repo();
		await writeFile(join(cwd, "b.ts"), "second\n");
		gitIn(cwd, "add", "-A");
		gitIn(cwd, "commit", "-qm", "second");
		const from = gitIn(cwd, "rev-parse", "HEAD").trim();
		const s = await start({
			cwd,
			turns: [
				MEDIUM_TURN,
				[DECLARED_NONE, call("git", { args: ["reset", "-q", "--soft", "HEAD~1"] }), { event: finished }],
			],
		});
		const [assessed] = ofType(await s.send("edit"), "review_assessed");
		expect(assessed?.files.slice().sort()).toEqual(["a.ts", "b.ts"]);
		expect(assessed?.baseNote).toBe(
			`HEAD no longer descends from ${from.slice(0, 7)}, where the turn started: the base is the current HEAD`,
		);
		await s.session.close();
	});

	it("S5 does not claim a pass when the verifier omits all requirement verdicts", async () => {
		const roles = new RoleBackend(verifying(vreport([], [])));
		const s = await start({
			turns: [[call("risk", { items: [2], reason: "approval guard" }), ...MEDIUM_TURN]],
			roles,
			consent: "declined",
		});
		const events = await s.send("Require a keypress for approval");
		expect(ofType(events, "verification_finished")[0]?.outcome).toBe("failed");
		await s.session.close();
	});

	it.each(["unmet", "unverified"])("S5 does not call an %s requirement a pass", async (verdict) => {
		const roles = new RoleBackend(
			verifying(
				vreport([], [{ ...vrequirement, verdict, evidence: "candidate still accepts pasted y, or cannot be checked" }]),
			),
		);
		const s = await start({
			turns: [[call("risk", { items: [2], reason: "approval guard" }), ...MEDIUM_TURN]],
			roles,
			consent: "declined",
		});
		const events = await s.send("Require a keypress for approval");
		expect(["needs_decision", "failed"]).toContain(ofType(events, "verification_finished")[0]?.outcome);
		await s.session.close();
	});
});

describe("independent M9 dependency-write isolation", () => {
	it.each(["success", "failure", "interrupt"])("S5 preserves dependencies after %s", async (mode) => {
		const cwd = await repo();
		await writeFile(join(cwd, ".gitignore"), "node_modules\n");
		await mkdir(join(cwd, "node_modules/dep"), { recursive: true });
		await writeFile(join(cwd, "node_modules/dep/index.js"), "original\n");
		gitIn(cwd, "add", "-A");
		gitIn(cwd, "commit", "-qm", "dependencies");
		const before = {
			index: await readFile(join(cwd, ".git/index")),
			refs: gitIn(cwd, "for-each-ref") + gitIn(cwd, "rev-parse", "HEAD"),
			dep: await readFile(join(cwd, "node_modules/dep/index.js")),
		};
		const roles = new RoleBackend(
			(role, prompt) => {
				if (role !== "verifier") return clean(role, prompt);
				if (mode === "failure") throw new Error("probe failure");
				return mode === "interrupt" ? HOLD : vreport();
			},
			(role) =>
				role === "verifier"
					? [
							{
								tool: "bash",
								input: { command: "printf 'changed\\n' > candidate/node_modules/dep/index.js" },
								callId: "dependency-write",
							},
						]
					: [],
		);
		const s = await start({
			cwd,
			roles,
			consent: "declined",
			turns: [[call("risk", { items: [2], reason: "guard" }), ...MEDIUM_TURN]],
		});
		try {
			const pending = s.send("Implement the approval guard");
			if (mode === "interrupt") {
				for (let i = 0; i < 400 && roles.probed.length === 0; i++)
					await new Promise((resolve) => setTimeout(resolve, 5));
				expect(roles.probed).toHaveLength(1);
				await s.session.interrupt();
			}
			await pending;
			expect(roles.probed[0]?.ok).toBe(true);
			await expect(stat(roles.roles[0]?.cwd ?? "")).rejects.toThrow();
			expect(await readFile(join(cwd, ".git/index"))).toEqual(before.index);
			expect(gitIn(cwd, "for-each-ref") + gitIn(cwd, "rev-parse", "HEAD")).toBe(before.refs);
			expect(await readFile(join(cwd, "a.ts"), "utf8")).toBe("base\nmore\n");
			expect(await readFile(join(cwd, "node_modules/dep/index.js"))).toEqual(before.dep);
		} finally {
			await s.session.close();
		}
	});
});

describe("independent M9 approval regression", () => {
	it("S5 keeps main and worker commands behind approval", async () => {
		const { bashTool, BUILTIN_AGENTS } = await import("../src/index.ts");
		const child = new FakeBackend([
			[call("bash", { command: "echo forbidden > marker" }), text("worker report"), { event: finished }],
		]);
		const approvals: string[] = [];
		const s = await start({
			review: false,
			turns: [
				[
					call("bash", { command: "echo forbidden > marker" }),
					call("task", { agent: "worker", prompt: "check" }),
					{ event: finished },
				],
			],
			extra: {
				tools: [bashTool],
				approve: async ({ command }) => {
					approvals.push(command);
					return false;
				},
				subagents: { agents: BUILTIN_AGENTS, createBackend: () => child },
			},
		});
		try {
			const events = await s.send("check approvals");
			expect(approvals).toEqual(["echo forbidden > marker", "echo forbidden > marker"]);
			expect(ofType(events, "approval_requested").map((event) => event.agent ?? "main")).toEqual(["main", "worker"]);
			expect(s.main.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
			expect(child.toolResults[0]).toEqual({ ok: false, output: "The user denied this command." });
			await expect(stat(join(s.cwd, "marker"))).rejects.toThrow();
		} finally {
			await s.session.close();
		}
	});
});
