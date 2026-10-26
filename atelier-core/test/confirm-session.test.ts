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
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

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

const bashCall = (input: Record<string, string | boolean>): FakeStep => ({
	toolCall: { tool: "bash", input, callId: "c1" },
});
const finished: FakeStep = {
	event: { type: "turn_finished", stopReason: "end_turn", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
};

async function collect(events: AsyncIterable<AtelierEvent>) {
	const out: AtelierEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

/** One turn calling bash with `input`; every question is answered with `answer`. */
async function ask(
	input: Record<string, string | boolean>,
	options: Partial<SessionOptions> & { answer?: boolean; bash?: Parameters<typeof createBashTool>[0] } = {},
) {
	const { answer = true, bash, ...rest } = options;
	const { sandbox, wrapped } = sandboxed();
	const questions: ApprovalRequest[] = [];
	const backend = new FakeBackend([[bashCall(input), finished]]);
	const session = await Session.start({
		backend,
		cwd,
		tools: [createBashTool({ sandbox, ...bash })],
		approve: async (request) => {
			questions.push(request);
			return answer;
		},
		...rest,
	});
	const events = await collect(session.send("go"));
	await session.close();
	const requested = events.filter(
		(event): event is Extract<AtelierEvent, { type: "approval_requested" }> => event.type === "approval_requested",
	);
	return { questions, requested, wrapped, result: backend.toolResults[0] };
}

describe("a command the guard asks about", () => {
	const removal = { command: "rm -rf build" };

	it.each([
		["the default mode", {}],
		["normal", { permissionMode: "normal" }],
		["auto", { permissionMode: "auto" }],
		["yolo", { permissionMode: "yolo" }],
	] as const)("is asked in %s although the sandbox contains it, naming the rule", async (_name, options) => {
		const { questions, requested, wrapped, result } = await ask(removal, options);
		expect(questions).toEqual([{ callId: "c1", command: "rm -rf build", confirm: "recursive removal" }]);
		expect(requested).toEqual([
			expect.objectContaining({ callId: "c1", command: "rm -rf build", confirm: "recursive removal" }),
		]);
		expect(wrapped).toEqual(["rm -rf build"]);
		expect(result?.output).toContain("exit code 0");
	});

	it.each(["normal", "auto", "yolo"] as const)("does not run when the user says no in %s", async (permissionMode) => {
		const { wrapped, result } = await ask(removal, { permissionMode, answer: false });
		expect(result).toEqual({ ok: false, output: "The user denied this command." });
		expect(wrapped).toEqual([]);
	});

	it("does not run without anyone to ask", async () => {
		const { sandbox, wrapped } = sandboxed();
		const backend = new FakeBackend([[bashCall(removal), finished]]);
		const session = await Session.start({ backend, cwd, tools: [createBashTool({ sandbox })], permissionMode: "yolo" });
		await collect(session.send("go"));
		expect(backend.toolResults).toEqual([{ ok: false, output: "The user denied this command." }]);
		expect(wrapped).toEqual([]);
	});

	it("never reaches the classifier in auto", async () => {
		let created = 0;
		const { questions } = await ask(removal, {
			permissionMode: "auto",
			permissionClassifier: {
				createBackend: () => {
					created++;
					return new FakeBackend([[]]);
				},
			},
		});
		expect(created).toBe(0);
		expect(questions).toHaveLength(1);
	});

	it("asks in yolo when it also runs outside the sandbox, with the reason", async () => {
		const { questions } = await ask(
			{ command: "npm publish", unsandboxed: true, reason: "needs the registry" },
			{ permissionMode: "yolo" },
		);
		expect(questions).toEqual([
			{ callId: "c1", command: "npm publish", reason: "needs the registry", confirm: "npm publish" },
		]);
	});

	it.each([
		"npm publish",
		"git branch -D old",
		"psql -c 'DROP TABLE users'",
		"find build -delete",
		"git push --force",
		"git rebase -i main",
		"git push && rm -rf data",
	])("asks for %j in yolo", async (command) => {
		const { questions } = await ask({ command }, { permissionMode: "yolo", answer: false });
		expect(questions.map((question) => question.command)).toEqual([command]);
	});

	it.each(["git push -u origin feat", "git rebase main", "git fetch && git rebase origin/main && git push"])(
		"runs %j without asking in yolo",
		async (command) => {
			const { questions, requested, wrapped } = await ask({ command }, { permissionMode: "yolo", answer: false });
			expect(questions).toEqual([]);
			expect(requested).toEqual([]);
			expect(wrapped).toEqual([command]);
		},
	);

	it.each(["normal", "auto"] as const)("asks for a plain push in %s", async (permissionMode) => {
		const { questions } = await ask({ command: "git push -u origin feat" }, { permissionMode });
		expect(questions).toEqual([{ callId: "c1", command: "git push -u origin feat", confirm: "git push" }]);
	});

	it.each(["normal", "auto", "yolo"] as const)(
		"is refused when catastrophic, and nobody is asked, in %s",
		async (permissionMode) => {
			const { questions, wrapped, result } = await ask({ command: "rm -rf /" }, { permissionMode });
			expect(questions).toEqual([]);
			expect(wrapped).toEqual([]);
			expect(result?.output).toBe("Refused: recursive removal of / — rm -rf /");
		},
	);

	it.each(["normal", "auto", "yolo"] as const)(
		"does not ask for an ordinary sandboxed command in %s",
		async (permissionMode) => {
			const { questions, requested, wrapped } = await ask({ command: "pnpm test" }, { permissionMode });
			expect(questions).toEqual([]);
			expect(requested).toEqual([]);
			expect(wrapped).toEqual(["pnpm test"]);
		},
	);

	it("keeps the verifier's bash free of questions: it runs in a throwaway copy", async () => {
		const { questions, result } = await ask(removal, {
			permissionMode: "normal",
			bash: { withoutApproval: true, policy: "verifier" },
		});
		expect(questions).toEqual([]);
		expect(result?.output).toContain("exit code 0");
	});
});
