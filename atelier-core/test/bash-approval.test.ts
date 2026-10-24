import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	type ApprovalRequest,
	type AtelierEvent,
	createBashTool,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { NOT_AVAILABLE_ON_PLATFORM, Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

/** The system temporary directory: commands need a working directory they can read, also inside a sandbox. */
const cwd = tmpdir();

/** A sandbox that is there and wraps nothing, counting the commands it wrapped. */
function sandboxed() {
	const wrapped: string[] = [];
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {},
		wrapWithSandbox: async (command) => {
			wrapped.push(command);
			return command;
		},
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	return { sandbox: new Sandbox({ platform: "darwin", manager }), wrapped };
}

const unavailable = () => new Sandbox({ platform: "linux" });

const bashCall = (input: Record<string, string | boolean>, callId = "c1"): FakeStep => ({
	toolCall: { tool: "bash", input, callId },
});
const finished: FakeStep = {
	event: { type: "turn_finished", stopReason: "end_turn", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
};

async function collect(events: AsyncIterable<AtelierEvent>) {
	const out: AtelierEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

/** Runs the turns of a session whose only tool is the given bash, answering every question with `answer`. */
async function run(
	turns: FakeStep[][],
	tool: ReturnType<typeof createBashTool>,
	options: Partial<SessionOptions> & { answer?: boolean } = {},
) {
	const { answer = true, ...rest } = options;
	const questions: ApprovalRequest[] = [];
	const backend = new FakeBackend(turns);
	const session = await Session.start({
		backend,
		cwd,
		tools: [tool],
		approve: async (request) => {
			questions.push(request);
			return answer;
		},
		...rest,
	});
	const events: AtelierEvent[][] = [];
	for (let i = 0; i < turns.length; i++) events.push(await collect(session.send(`turn ${i}`)));
	return { backend, questions, events, results: backend.toolResults };
}

const ofType = <T extends AtelierEvent["type"]>(events: AtelierEvent[], type: T) =>
	events.filter((event): event is Extract<AtelierEvent, { type: T }> => event.type === type);

describe("a sandboxed command", () => {
	it("still asks for approval, with the command alone", async () => {
		const { sandbox } = sandboxed();
		const { questions, events, results } = await run(
			[[bashCall({ command: "echo hi" }), finished]],
			createBashTool({ sandbox }),
		);
		expect(questions).toEqual([{ callId: "c1", command: "echo hi" }]);
		expect(ofType(events[0] ?? [], "approval_requested")).toEqual([
			expect.objectContaining({ type: "approval_requested", callId: "c1", command: "echo hi" }),
		]);
		expect(ofType(events[0] ?? [], "approval_requested")[0]).not.toHaveProperty("reason");
		expect(results[0]?.output).toContain("hi");
		expect(ofType(events[0] ?? [], "sandbox_warning")).toEqual([]);
	});

	it("is approved by --yes without a question, and runs wrapped", async () => {
		const { sandbox, wrapped } = sandboxed();
		const { questions, events, results } = await run(
			[[bashCall({ command: "echo hi" }), finished]],
			createBashTool({ sandbox }),
			{ autoApprove: true },
		);
		expect(questions).toEqual([]);
		expect(ofType(events[0] ?? [], "approval_requested")).toEqual([]);
		expect(wrapped).toEqual(["echo hi"]);
		expect(results[0]?.output).toContain("hi");
	});
});

describe("running outside the sandbox", () => {
	const leave = { command: "echo outside", unsandboxed: true, reason: "needs the network to install" };

	it("is always asked, even with --yes, with the reason, and then runs unwrapped", async () => {
		const { sandbox, wrapped } = sandboxed();
		const { questions, events, results } = await run([[bashCall(leave), finished]], createBashTool({ sandbox }), {
			autoApprove: true,
		});
		expect(questions).toEqual([
			{ callId: "c1", command: "echo outside", reason: "needs the network to install", always: true },
		]);
		expect(ofType(events[0] ?? [], "approval_requested")).toEqual([
			expect.objectContaining({ callId: "c1", command: "echo outside", reason: "needs the network to install" }),
		]);
		expect(wrapped).toEqual([]);
		expect(results[0]?.output).toContain("outside");
	});

	it("does not run when the user says no, and does not run without anyone to ask", async () => {
		const { sandbox, wrapped } = sandboxed();
		const denied = await run([[bashCall(leave), finished]], createBashTool({ sandbox }), {
			autoApprove: true,
			answer: false,
		});
		expect(denied.results).toEqual([{ ok: false, output: "The user denied this command." }]);

		const backend = new FakeBackend([[bashCall(leave), finished]]);
		const session = await Session.start({ backend, cwd, tools: [createBashTool({ sandbox })], autoApprove: true });
		await collect(session.send("go"));
		expect(backend.toolResults).toEqual([{ ok: false, output: "The user denied this command." }]);
		expect(wrapped).toEqual([]);
	});

	it.each([
		["no reason", { command: "echo outside", unsandboxed: true }],
		["a blank reason", { command: "echo outside", unsandboxed: true, reason: "  " }],
	])("is refused with %s, and nobody is asked", async (_name, input) => {
		const { sandbox } = sandboxed();
		const { questions, results } = await run([[bashCall(input), finished]], createBashTool({ sandbox }), {
			autoApprove: true,
		});
		expect(questions).toEqual([]);
		expect(results[0]?.ok).toBe(false);
		expect(results[0]?.output).toMatch(/^Invalid input: reason is required with unsandboxed/);
	});

	it("is never granted to the verifier's bash", async () => {
		const { sandbox } = sandboxed();
		const verifier = createBashTool({ sandbox, withoutApproval: true, policy: "verifier" });
		const { questions, results } = await run([[bashCall(leave), finished]], verifier);
		expect(questions).toEqual([]);
		expect(results).toEqual([
			{ ok: false, output: "Refused: the verifier's bash cannot run outside the sandbox — echo outside" },
		]);
		const direct = await verifier.execute(leave, { cwd });
		expect(direct.ok).toBe(false);
		expect(direct.output).toBe("Refused: the verifier's bash cannot run outside the sandbox — echo outside");
	});

	it("does not let the guard be skipped: a destructive command is refused, not asked", async () => {
		const { sandbox } = sandboxed();
		const { questions, results } = await run(
			[[bashCall({ command: "sudo -n true", unsandboxed: true, reason: "needs root" }), finished]],
			createBashTool({ sandbox }),
			{ autoApprove: true },
		);
		expect(questions).toEqual([]);
		expect(results).toEqual([{ ok: false, output: "Refused: sudo — sudo -n true" }]);
	});
});

describe("without a sandbox", () => {
	it.each([
		["unavailable on this platform", () => ({ sandbox: unavailable() }), {}, NOT_AVAILABLE_ON_PLATFORM],
		[
			"turned off",
			() => ({ sandbox: sandboxed().sandbox }),
			{ noSandbox: true },
			"sandbox turned off for this session",
		],
	] as const)(
		"%s: every command asks, even with --yes, and the turn is warned",
		async (_name, make, options, reason) => {
			const turn = [bashCall({ command: "echo one" }, "c1"), bashCall({ command: "echo two" }, "c2"), finished];
			const { questions, events, results } = await run([turn], createBashTool(make()), {
				autoApprove: true,
				...options,
			});
			expect(questions).toEqual([
				{ callId: "c1", command: "echo one", always: true },
				{ callId: "c2", command: "echo two", always: true },
			]);
			expect(results.map((result) => result.ok)).toEqual([true, true]);
			// Once for the turn, before the first question.
			expect(ofType(events[0] ?? [], "sandbox_warning")).toEqual([
				{ type: "sandbox_warning", reason, seq: expect.any(Number), turnId: expect.any(String) },
			]);
			const kinds = (events[0] ?? []).map((event) => event.type);
			expect(kinds.indexOf("sandbox_warning")).toBeLessThan(kinds.indexOf("approval_requested"));
		},
	);

	it("warns again in every turn that runs a command", async () => {
		const turn = [bashCall({ command: "echo hi" }), finished];
		const { events } = await run([turn, turn], createBashTool({ sandbox: unavailable() }));
		expect(events.map((turnEvents) => ofType(turnEvents, "sandbox_warning").length)).toEqual([1, 1]);
	});

	it("does not run a command nobody approved, --yes or not", async () => {
		const { events, results } = await run(
			[[bashCall({ command: "echo hi" }), finished]],
			createBashTool({ sandbox: unavailable() }),
			{
				autoApprove: true,
				answer: false,
			},
		);
		expect(results).toEqual([{ ok: false, output: "The user denied this command." }]);
		expect(ofType(events[0] ?? [], "sandbox_warning")).toHaveLength(1);
	});

	it("runs the command unwrapped with --no-sandbox even when a sandbox exists", async () => {
		const { sandbox, wrapped } = sandboxed();
		await run([[bashCall({ command: "echo hi" }), finished]], createBashTool({ sandbox }), { noSandbox: true });
		expect(wrapped).toEqual([]);
	});

	it("keeps the verifier's bash unavailable with --no-sandbox", async () => {
		const { sandbox, wrapped } = sandboxed();
		const verifier = createBashTool({ sandbox, withoutApproval: true, policy: "verifier" });
		const result = await verifier.execute({ command: "echo hi" }, { cwd, sandboxOff: true });
		expect(result.ok).toBe(false);
		expect(result.output).toBe("[bash is not available: sandbox turned off for this session]");
		expect(wrapped).toEqual([]);
	});

	it("passes --no-sandbox on to the subagents", async () => {
		const { sandbox } = sandboxed();
		const child = new FakeBackend([[bashCall({ command: "echo child" }, "k1"), finished]]);
		const parent = new FakeBackend([
			[{ toolCall: { tool: "task", input: { agent: "worker", prompt: "go" }, callId: "t1" } }, finished],
		]);
		const questions: ApprovalRequest[] = [];
		const session = await Session.start({
			backend: parent,
			cwd,
			tools: [createBashTool({ sandbox })],
			autoApprove: true,
			noSandbox: true,
			approve: async (request) => {
				questions.push(request);
				return true;
			},
			subagents: {
				agents: [{ name: "worker", description: "w", tools: ["bash"], prompt: "W", models: {}, maxRequests: 5 }],
				createBackend: () => child,
			},
		});
		const events = await collect(session.send("go"));
		expect(questions).toEqual([{ callId: "k1", command: "echo child", always: true }]);
		expect(ofType(events, "sandbox_warning")).toHaveLength(1);
	});
});
