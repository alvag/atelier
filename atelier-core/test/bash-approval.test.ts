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

/** A sandbox on macOS whose library fails to start, the way a socket path too long for macOS did. */
function failed(how: "initialize" | "dependencies" = "initialize") {
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: how === "dependencies" ? ["sandbox-exec not found"] : [], warnings: [] }),
		initialize: async () => {
			throw new Error("listen EINVAL: invalid argument /a/long/path/srt-mux-1-0.sock");
		},
		wrapWithSandbox: async (command) => command,
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	return new Sandbox({ platform: "darwin", manager });
}

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
	it.each([
		["the default mode", {}],
		["normal", { permissionMode: "normal" }],
		["auto", { permissionMode: "auto" }],
		["yolo", { permissionMode: "yolo" }],
	] as const)("runs wrapped without a question in %s", async (_name, options) => {
		const { sandbox, wrapped } = sandboxed();
		const { questions, events, results } = await run(
			[[bashCall({ command: "echo hi" }), finished]],
			createBashTool({ sandbox }),
			options,
		);
		expect(questions).toEqual([]);
		expect(ofType(events[0] ?? [], "approval_requested")).toEqual([]);
		expect(ofType(events[0] ?? [], "sandbox_warning")).toEqual([]);
		expect(wrapped).toEqual(["echo hi"]);
		expect(results[0]?.output).toContain("hi");
	});
});

describe("running outside the sandbox", () => {
	const leave = { command: "echo outside", unsandboxed: true, reason: "needs the network to install" };

	it.each([
		["the default mode", {}],
		["normal", { permissionMode: "normal" }],
		["auto", { permissionMode: "auto" }],
	] as const)("is asked in %s, with the reason, and then runs unwrapped", async (_name, options) => {
		const { sandbox, wrapped } = sandboxed();
		const { questions, events, results } = await run(
			[[bashCall(leave), finished]],
			createBashTool({ sandbox }),
			options,
		);
		expect(questions).toEqual([{ callId: "c1", command: "echo outside", reason: "needs the network to install" }]);
		expect(ofType(events[0] ?? [], "approval_requested")).toEqual([
			expect.objectContaining({ callId: "c1", command: "echo outside", reason: "needs the network to install" }),
		]);
		expect(wrapped).toEqual([]);
		expect(results[0]?.output).toContain("outside");
	});

	it("runs unwrapped without a question in yolo", async () => {
		const { sandbox, wrapped } = sandboxed();
		const { questions, events, results } = await run([[bashCall(leave), finished]], createBashTool({ sandbox }), {
			permissionMode: "yolo",
			answer: false,
		});
		expect(questions).toEqual([]);
		expect(ofType(events[0] ?? [], "approval_requested")).toEqual([]);
		expect(wrapped).toEqual([]);
		expect(results[0]).toMatchObject({ ok: true });
		expect(results[0]?.output).toContain("outside");
	});

	it("does not run when the user says no, and does not run without anyone to ask", async () => {
		const { sandbox, wrapped } = sandboxed();
		const denied = await run([[bashCall(leave), finished]], createBashTool({ sandbox }), { answer: false });
		expect(denied.results).toEqual([{ ok: false, output: "The user denied this command." }]);

		const backend = new FakeBackend([[bashCall(leave), finished]]);
		const session = await Session.start({ backend, cwd, tools: [createBashTool({ sandbox })] });
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
			permissionMode: "yolo",
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

	it.each(["normal", "auto", "yolo"] as const)(
		"does not let the guard be skipped in %s: a destructive command is refused, not asked",
		async (permissionMode) => {
			const { sandbox } = sandboxed();
			const { questions, results } = await run(
				[[bashCall({ command: "sudo -n true", unsandboxed: true, reason: "needs root" }), finished]],
				createBashTool({ sandbox }),
				{ permissionMode },
			);
			expect(questions).toEqual([]);
			expect(results).toEqual([{ ok: false, output: "Refused: sudo — sudo -n true" }]);
		},
	);
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
	] as const)("%s: every command asks in normal, and the turn is warned", async (_name, make, options, reason) => {
		const turn = [bashCall({ command: "echo one" }, "c1"), bashCall({ command: "echo two" }, "c2"), finished];
		const { questions, events, results } = await run([turn], createBashTool(make()), {
			permissionMode: "normal",
			...options,
		});
		expect(questions).toEqual([
			{ callId: "c1", command: "echo one" },
			{ callId: "c2", command: "echo two" },
		]);
		expect(results.map((result) => result.ok)).toEqual([true, true]);
		// Once for the turn, before the first question.
		expect(ofType(events[0] ?? [], "sandbox_warning")).toEqual([
			{ type: "sandbox_warning", reason, seq: expect.any(Number), turnId: expect.any(String) },
		]);
		const kinds = (events[0] ?? []).map((event) => event.type);
		expect(kinds.indexOf("sandbox_warning")).toBeLessThan(kinds.indexOf("approval_requested"));
	});

	it("runs every command without a question in yolo, and still warns the turn", async () => {
		const { questions, events, results } = await run(
			[[bashCall({ command: "echo hi" }), finished]],
			createBashTool({ sandbox: unavailable() }),
			{ permissionMode: "yolo", answer: false },
		);
		expect(questions).toEqual([]);
		expect(results[0]).toMatchObject({ ok: true });
		expect(ofType(events[0] ?? [], "sandbox_warning")).toHaveLength(1);
	});

	it.each(["initialize", "dependencies"] as const)(
		"asks in yolo too when the sandbox failed to start (%s), and runs nothing the user denies",
		async (how) => {
			const denied = await run(
				[[bashCall({ command: "echo hi" }), finished]],
				createBashTool({ sandbox: failed(how) }),
				{
					permissionMode: "yolo",
					answer: false,
				},
			);
			expect(denied.questions).toEqual([{ callId: "c1", command: "echo hi" }]);
			expect(denied.results).toEqual([{ ok: false, output: "The user denied this command." }]);
			expect(ofType(denied.events[0] ?? [], "sandbox_warning")).toHaveLength(1);

			const allowed = await run(
				[[bashCall({ command: "echo hi" }), finished]],
				createBashTool({ sandbox: failed(how) }),
				{
					permissionMode: "yolo",
				},
			);
			expect(allowed.questions).toEqual([{ callId: "c1", command: "echo hi" }]);
			expect(allowed.results[0]?.output).toContain("hi");
		},
	);

	it("runs without a question in yolo when the sandbox was turned off", async () => {
		const { questions, results } = await run(
			[[bashCall({ command: "echo hi" }), finished]],
			createBashTool({ sandbox: failed() }),
			{ permissionMode: "yolo", noSandbox: true, answer: false },
		);
		expect(questions).toEqual([]);
		expect(results[0]).toMatchObject({ ok: true });
	});

	it("warns again in every turn that runs a command", async () => {
		const turn = [bashCall({ command: "echo hi" }), finished];
		const { events } = await run([turn, turn], createBashTool({ sandbox: unavailable() }));
		expect(events.map((turnEvents) => ofType(turnEvents, "sandbox_warning").length)).toEqual([1, 1]);
	});

	it("does not run a command nobody approved in normal", async () => {
		const { events, results } = await run(
			[[bashCall({ command: "echo hi" }), finished]],
			createBashTool({ sandbox: unavailable() }),
			{ answer: false },
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
		expect(questions).toEqual([{ callId: "k1", command: "echo child" }]);
		expect(ofType(events, "sandbox_warning")).toHaveLength(1);
	});
});

describe("Session.setPermissionMode", () => {
	const outside = (callId: string): FakeStep[] => [
		bashCall({ command: "echo hi", unsandboxed: true, reason: "needs the network" }, callId),
		finished,
	];

	async function start(turns: FakeStep[][], options: Partial<SessionOptions> = {}) {
		const questions: ApprovalRequest[] = [];
		const session = await Session.start({
			backend: new FakeBackend(turns),
			cwd,
			tools: [createBashTool({ sandbox: sandboxed().sandbox })],
			approve: async (request) => {
				questions.push(request);
				return true;
			},
			...options,
		});
		return { session, questions };
	}

	it("changes whether a command outside the sandbox asks, from the next tool call on", async () => {
		const { session, questions } = await start([outside("a"), outside("b"), outside("c")]);
		await collect(session.send("one"));
		expect(questions.map((q) => q.callId)).toEqual(["a"]);
		session.setPermissionMode("yolo");
		await collect(session.send("two"));
		expect(questions.map((q) => q.callId)).toEqual(["a"]);
		session.setPermissionMode("normal");
		await collect(session.send("three"));
		expect(questions.map((q) => q.callId)).toEqual(["a", "c"]);
	});

	it("is said by the next session_started", async () => {
		const started: FakeStep = {
			event: { type: "session_started", backend: "fake", model: "m", authSource: "none" },
		};
		const { session } = await start([
			[started, finished],
			[started, finished],
		]);
		const first = await collect(session.send("one"));
		session.setPermissionMode("yolo");
		const second = await collect(session.send("two"));
		expect(ofType(first, "session_started").map((e) => e.permissionMode)).toEqual(["normal"]);
		expect(ofType(second, "session_started").map((e) => e.permissionMode)).toEqual(["yolo"]);
	});
});

describe("permissionModeProblem", () => {
	it("is said once, in the first turn, as a recoverable permission_mode_invalid error", async () => {
		const session = await Session.start({
			backend: new FakeBackend([[finished], [finished]]),
			cwd,
			tools: [],
			permissionModeProblem: "/h/.atelier/permission-mode.json: not valid JSON; using normal",
		});
		const first = await collect(session.send("one"));
		const second = await collect(session.send("two"));
		expect(ofType(first, "error")).toMatchObject([
			{
				code: "permission_mode_invalid",
				message: "/h/.atelier/permission-mode.json: not valid JSON; using normal",
				recoverable: true,
			},
		]);
		expect(ofType(second, "error")).toEqual([]);
	});
});
