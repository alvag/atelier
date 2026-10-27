import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	type ApprovalAnswer,
	type ApprovalRequest,
	type AtelierEvent,
	createBashTool,
	FakeBackend,
	type FakeStep,
	PermissionRules,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

const cwd = tmpdir();
let home: string;

beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-session-rules-"));
});

/** A sandbox that is there and wraps nothing, counting what it wrapped; covered commands run plainly. */
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
	return { sandbox: new Sandbox({ platform: "darwin", manager, outside: () => true }), wrapped };
}

const bashCall = (input: Record<string, string | boolean>, callId: string): FakeStep => ({
	toolCall: { tool: "bash", input, callId },
});
const leave = (command: string, callId: string) =>
	bashCall({ command, unsandboxed: true, reason: "a GUI app" }, callId);
const finished: FakeStep = {
	event: { type: "turn_finished", stopReason: "end_turn", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
};

async function collect(events: AsyncIterable<AtelierEvent>) {
	const out: AtelierEvent[] = [];
	for await (const event of events) out.push(event);
	return out;
}

/** Runs the turns with the given rules, answering each question with the next answer (then no). */
async function run(
	turns: FakeStep[][],
	{
		answers = [],
		rules = new PermissionRules({ home }),
		...rest
	}: Partial<SessionOptions> & {
		answers?: ApprovalAnswer[];
		rules?: PermissionRules;
	} = {},
) {
	const { sandbox, wrapped } = sandboxed();
	const questions: ApprovalRequest[] = [];
	const backend = new FakeBackend(turns);
	const session = await Session.start({
		backend,
		cwd,
		tools: [createBashTool({ sandbox })],
		permissionRules: rules,
		approve: async (request) => {
			questions.push(request);
			return answers[questions.length - 1] ?? false;
		},
		...rest,
	});
	const events: AtelierEvent[] = [];
	for (let i = 0; i < turns.length; i++) events.push(...(await collect(session.send(`turn ${i}`))));
	return { backend, questions, events, wrapped, results: backend.toolResults, rules };
}

const ofType = <T extends AtelierEvent["type"]>(events: AtelierEvent[], type: T) =>
	events.filter((event): event is Extract<AtelierEvent, { type: T }> => event.type === type);

describe("remembered answers", () => {
	it("offers the command's rules, and Allow in this session stops asking for the rest of it", async () => {
		const { questions, events, wrapped, results, rules } = await run(
			[
				[leave("echo -n one", "c1"), finished],
				[bashCall({ command: "echo -n two" }, "c2"), finished],
			],
			{ answers: [{ remember: "session" }] },
		);
		expect(questions).toEqual([expect.objectContaining({ callId: "c1", remember: { rules: ["echo"], always: true } })]);
		expect(ofType(events, "approval_requested")).toEqual([
			expect.objectContaining({ callId: "c1", remember: { rules: ["echo"], always: true } }),
		]);
		expect(wrapped).toEqual([]);
		expect(results[1]?.output).toContain("two");
		expect(results[1]?.output).toContain("[ran outside the sandbox: the user allows echo");
		expect(await rules.list()).toEqual([expect.objectContaining({ scope: "session", kind: "bash", value: "echo" })]);
	});

	it("Allow always saves the rule; a later session runs it without asking and its prompt lists it", async () => {
		await run([[leave("echo -n one", "c1"), finished]], { answers: [{ remember: "always" }] });
		expect(JSON.parse(await readFile(join(home, ".atelier", "permissions.json"), "utf8")).allow).toEqual([
			{ bash: "echo" },
		]);
		const later = await run([[leave("echo -n again", "c1"), finished]]);
		expect(later.questions).toEqual([]);
		expect(later.results[0]?.output).toContain("again");
		expect(later.backend.startOptions?.systemPromptAppend).toContain(
			"The user allows these bash commands outside the sandbox without asking: echo.",
		);
	});

	it("offers no Allow always for an interpreter, and keeps such an answer for the session only", async () => {
		const { questions, events, rules } = await run([[leave("node -e 1", "c1"), finished]], {
			answers: [{ remember: "always" }],
		});
		expect(questions[0]?.remember).toEqual({ rules: ["node"], always: false });
		expect(ofType(events, "error")).toEqual([
			expect.objectContaining({ code: "permission_rules_not_saved", recoverable: true }),
		]);
		expect(await rules.list()).toEqual([expect.objectContaining({ scope: "session", value: "node" })]);
	});

	it("never offers to remember what the guard asks about", async () => {
		const { questions } = await run([[bashCall({ command: "rm -r build" }, "c1"), finished]], {
			rules: await allowed("rm"),
		});
		expect(questions).toEqual([expect.objectContaining({ confirm: "recursive removal" })]);
		expect(questions[0]?.remember).toBeUndefined();
	});

	it("in auto a covered command reaches no classifier", async () => {
		const made: FakeBackend[] = [];
		const { questions, results } = await run([[leave("echo -n auto", "c1"), finished]], {
			rules: await allowed("echo"),
			permissionMode: "auto",
			permissionClassifier: {
				createBackend: () => {
					const backend = new FakeBackend([[]]);
					made.push(backend);
					return backend;
				},
			},
		});
		expect(made).toEqual([]);
		expect(questions).toEqual([]);
		expect(results[0]?.output).toContain("auto");
	});

	it("in yolo a covered command runs outside the sandbox from the start", async () => {
		const { wrapped, results } = await run([[bashCall({ command: "echo -n yolo" }, "c1"), finished]], {
			rules: await allowed("echo"),
			permissionMode: "yolo",
		});
		expect(wrapped).toEqual([]);
		expect(results[0]?.output).toContain("[ran outside the sandbox");
	});

	it("says once that the saved file is broken, and asks as if there were no rules", async () => {
		await mkdir(join(home, ".atelier"));
		await writeFile(join(home, ".atelier", "permissions.json"), "{");
		await chmod(join(home, ".atelier", "permissions.json"), 0o600);
		const { questions, events } = await run([[leave("echo -n a", "c1"), leave("echo -n b", "c2"), finished]], {
			answers: [true, true],
		});
		expect(questions).toHaveLength(2);
		expect(ofType(events, "error")).toEqual([
			expect.objectContaining({ code: "permission_rules_invalid", recoverable: true }),
		]);
	});
});

async function allowed(rule: string): Promise<PermissionRules> {
	const rules = new PermissionRules({ home });
	await rules.allow([{ kind: "bash", value: rule }], "session");
	return rules;
}
