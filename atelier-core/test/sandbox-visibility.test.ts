import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	type AtelierEvent,
	createBashTool,
	FakeBackend,
	type FakeStep,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import {
	NOT_AVAILABLE_ON_PLATFORM,
	SANDBOX_OFF,
	Sandbox,
	type SandboxManagerLike,
	type SandboxViolation,
} from "../src/tools/sandbox.ts";

/** The system temporary directory: commands need a working directory they can read, also inside a sandbox. */
const cwd = tmpdir();

/** How the library keys a violation: the first 100 characters of the run's id (or of the command), in base64. */
const keyOf = (idOrCommand: string) => Buffer.from(idOrCommand.slice(0, 100)).toString("base64");

/**
 * A sandbox that wraps nothing; when a command is wrapped it records the
 * violations `report` returns under the run's key, the way the library's log
 * monitor would, `delayMs` later (the log lags while the command runs).
 */
function sandboxWith(
	report: (command: string, run: number) => Pick<SandboxViolation, "line" | "command" | "encodedCommand">[] = () => [],
	seed: SandboxViolation[] = [],
	delayMs = 0,
) {
	const store: SandboxViolation[] = [...seed];
	let runs = 0;
	const manager: SandboxManagerLike = {
		isSupportedPlatform: () => true,
		checkDependencies: () => ({ errors: [], warnings: [] }),
		initialize: async () => {},
		wrapWithSandbox: async (command, _binShell, _custom, _signal, options) => {
			const encodedCommand = keyOf(options?.commandId || command);
			const record = (violations: Pick<SandboxViolation, "line" | "command" | "encodedCommand">[]) => {
				for (const violation of violations) store.push({ timestamp: new Date(), encodedCommand, ...violation });
			};
			const violations = report(command, runs++);
			if (delayMs === 0) record(violations);
			else setTimeout(() => record(violations), delayMs);
			return command;
		},
		getSandboxViolationStore: () => ({ getViolations: () => [...store] }),
		cleanupAfterCommand: () => {},
		reset: async () => {},
	};
	return new Sandbox({ platform: "darwin", manager });
}

const failing = "echo boom >&2; exit 1";

describe("the cause of a sandbox block", () => {
	it("is added to the result of a failed command: a blocked write", async () => {
		const sandbox = sandboxWith((command) => [
			{ command, line: "bash(41) deny(1) file-write-create /Users/ana/outside.txt" },
		]);
		const result = await createBashTool({ sandbox }).execute({ command: failing }, { cwd });
		expect(result.ok).toBe(false);
		expect(result.output).toBe(
			"boom\n\n[exit code 1]\n[sandbox blocked: write to /Users/ana/outside.txt (not an allowed write path)]",
		);
		expect(result.blocked).toEqual(["write to /Users/ana/outside.txt (not an allowed write path)"]);
	});

	it("names a blocked read", async () => {
		const sandbox = sandboxWith((command) => [
			{ command, line: "cat(52) deny(1) file-read-data /Users/ana/.ssh/id_rsa" },
		]);
		const result = await createBashTool({ sandbox }).execute({ command: failing }, { cwd });
		expect(result.output).toContain("[sandbox blocked: read of /Users/ana/.ssh/id_rsa (denied by the sandbox policy)]");
	});

	it("names a blocked connection with the library's reason, and the verifier's with its own", async () => {
		const line = "deny network-outbound example.com:80 (host is on the deny list)";
		const agent = await createBashTool({ sandbox: sandboxWith((command) => [{ command, line }]) }).execute(
			{ command: failing },
			{ cwd },
		);
		expect(agent.output).toContain("[sandbox blocked: network connect to example.com:80 (host is on the deny list)]");

		const verifier = await createBashTool({
			sandbox: sandboxWith((command) => [{ command, line }]),
			withoutApproval: true,
			policy: "verifier",
		}).execute({ command: failing }, { cwd });
		expect(verifier.output).toContain(
			"[sandbox blocked: network connect to example.com:80 (no network for the verifier)]",
		);
	});

	it("lists each distinct cause once and ignores the library's noise", async () => {
		const sandbox = sandboxWith((command) => [
			{ command, line: "bash(7) deny(1) sysctl-read kern.iossupportversion" },
			{ command, line: "bash(7) deny(1) mach-lookup com.apple.SystemConfiguration.configd" },
			{ command, line: "bash(7) deny(1) file-write-create /a/one" },
			{ command, line: "bash(7) deny(1) file-write-create /a/one" },
			{ command, line: "bash(7) deny(1) file-write-create /a/two" },
		]);
		const result = await createBashTool({ sandbox }).execute({ command: failing }, { cwd });
		expect(result.blocked).toEqual([
			"write to /a/one (not an allowed write path)",
			"write to /a/two (not an allowed write path)",
		]);
	});

	it("leaves out the system's own preference reads and puts the connection before the files", async () => {
		const sandbox = sandboxWith((command) => [
			{ command, line: "curl(7) deny(1) file-read-data /Library/Preferences/.GlobalPreferences.plist" },
			{
				command,
				line: "curl(7) deny(1) file-read-data /Users/ana/Library/Preferences/ByHost/.GlobalPreferences.1.plist",
			},
			{ command, line: "curl(7) deny(1) file-read-data /work/data.txt" },
			{ command, line: "deny network-outbound 127.0.0.1:8080" },
		]);
		const result = await createBashTool({ sandbox, withoutApproval: true, policy: "verifier" }).execute(
			{ command: failing },
			{ cwd },
		);
		expect(result.blocked).toEqual([
			"network connect to 127.0.0.1:8080 (no network for the verifier)",
			"read of /work/data.txt (denied by the sandbox policy)",
		]);
	});

	it("shows at most five causes and counts the rest", async () => {
		const sandbox = sandboxWith((command) =>
			Array.from({ length: 8 }, (_, i) => ({ command, line: `bash(7) deny(1) file-write-create /a/${i}` })),
		);
		const result = await createBashTool({ sandbox }).execute({ command: failing }, { cwd });
		expect(result.blocked).toHaveLength(6);
		expect(result.blocked?.[5]).toBe("and 3 more");
		expect(result.output.match(/\[sandbox blocked:/g)).toHaveLength(6);
	});

	it("adds nothing when the library reported no violation", async () => {
		const result = await createBashTool({ sandbox: sandboxWith() }).execute({ command: failing }, { cwd });
		expect(result.output).toBe("boom\n\n[exit code 1]");
		expect(result.blocked).toBeUndefined();
	});

	it("adds nothing when the command succeeded, even if the library saw denied probes", async () => {
		const sandbox = sandboxWith((command) => [{ command, line: "ls(9) deny(1) file-read-data /private/etc/secret" }]);
		const result = await createBashTool({ sandbox }).execute({ command: "echo fine" }, { cwd });
		expect(result.output).toBe("fine\n\n[exit code 0]");
		expect(result.blocked).toBeUndefined();
	});

	it("takes only the violations of this run, not those of an earlier run of the same text", async () => {
		const earlier: SandboxViolation = {
			command: failing,
			encodedCommand: keyOf(failing),
			line: "bash(7) deny(1) file-write-create /from/an/earlier/run",
			timestamp: new Date(Date.now() + 60_000),
		};
		const sandbox = sandboxWith(
			(command) => [
				{
					command: "some other command",
					encodedCommand: keyOf("another run"),
					line: "x(1) deny(1) file-write-create /not/mine",
				},
				{ command, line: "bash(7) deny(1) file-write-create /mine" },
			],
			[earlier],
		);
		const result = await createBashTool({ sandbox }).execute({ command: failing }, { cwd });
		expect(result.blocked).toEqual(["write to /mine (not an allowed write path)"]);
	});

	it("gives each of two overlapping runs of the same command only its own causes", async () => {
		const sandbox = sandboxWith(
			(command, run) => [{ command, line: `bash(7) deny(1) file-write-create /run/${run}` }],
			[],
			50,
		);
		const bash = createBashTool({ sandbox });
		const command = "sleep 0.3; exit 1";
		const [first, second] = await Promise.all([bash.execute({ command }, { cwd }), bash.execute({ command }, { cwd })]);
		const causes = [first?.blocked, second?.blocked];
		expect(causes).toContainEqual(["write to /run/0 (not an allowed write path)"]);
		expect(causes).toContainEqual(["write to /run/1 (not an allowed write path)"]);
	});

	it("gives a run that was not blocked none of the causes of an overlapping run of the same command", async () => {
		const sandbox = sandboxWith(
			(command, run) => (run === 0 ? [{ command, line: "bash(7) deny(1) file-write-create /run/0" }] : []),
			[],
			50,
		);
		const bash = createBashTool({ sandbox });
		const command = "sleep 0.3; exit 1";
		const results = await Promise.all([bash.execute({ command }, { cwd }), bash.execute({ command }, { cwd })]);
		expect(results.map((result) => result.blocked)).toEqual([
			["write to /run/0 (not an allowed write path)"],
			undefined,
		]);
	});

	it("does not take a violation the library could not attribute to a run, even with the same text", async () => {
		const unattributed: SandboxViolation = {
			command: failing,
			line: "bash(7) deny(1) file-write-create /whose",
			timestamp: new Date(Date.now() + 60_000),
		};
		const result = await createBashTool({ sandbox: sandboxWith(() => [], [unattributed]) }).execute(
			{ command: failing },
			{ cwd },
		);
		expect(result.blocked).toBeUndefined();
	});

	it("keeps the truncation note and the result of a long output, with the causes after the status", async () => {
		const sandbox = sandboxWith((command) => [{ command, line: "bash(7) deny(1) file-write-create /a/one" }]);
		const result = await createBashTool({ sandbox }).execute({ command: "seq 1 5000; exit 1" }, { cwd });
		expect(result.truncated).toBe(true);
		expect(result.output).toMatch(/^\[Output truncated; showing the end\./);
		expect(result.output).toMatch(
			/\[exit code 1\]\n\[sandbox blocked: write to \/a\/one \(not an allowed write path\)\]$/,
		);
	});

	it("is not looked for in a command that ran without the sandbox", async () => {
		const sandbox = new Sandbox({ platform: "linux" });
		const result = await createBashTool({ sandbox }).execute({ command: failing }, { cwd });
		expect(result.output).toBe("boom\n\n[exit code 1]");
		expect(result.blocked).toBeUndefined();
	});
});

const finished: FakeStep = {
	event: { type: "turn_finished", stopReason: "end_turn", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
};

async function turns(sandbox: Sandbox, steps: FakeStep[][], options: Partial<SessionOptions> = {}) {
	const session = await Session.start({
		backend: new FakeBackend(steps),
		cwd,
		tools: [createBashTool({ sandbox })],
		approve: async () => true,
		...options,
	});
	const out: AtelierEvent[][] = [];
	for (let i = 0; i < steps.length; i++) {
		const events: AtelierEvent[] = [];
		for await (const event of session.send(`turn ${i}`)) events.push(event);
		out.push(events);
	}
	return out;
}

const statuses = (events: AtelierEvent[]) => events.filter((event) => event.type === "sandbox_status");

describe("sandbox_status", () => {
	it("tells in the first turn that bash is sandboxed, and not again", async () => {
		const [first, second] = await turns(sandboxWith(), [[finished], [finished]]);
		expect(statuses(first ?? [])).toMatchObject([
			{ type: "sandbox_status", sandboxed: true, mechanism: "macOS seatbelt" },
		]);
		expect(first?.[0]?.type).toBe("sandbox_status");
		expect(statuses(second ?? [])).toEqual([]);
	});

	it("gives the reason when the platform has no sandbox", async () => {
		const [first] = await turns(new Sandbox({ platform: "linux" }), [[finished]]);
		const [status] = statuses(first ?? []);
		expect(status).toMatchObject({ sandboxed: false, reason: NOT_AVAILABLE_ON_PLATFORM });
		expect(status).not.toHaveProperty("mechanism");
	});

	it("says the sandbox is off when the session turned it off, without starting it", async () => {
		const [first] = await turns(sandboxWith(), [[finished]], { noSandbox: true });
		expect(statuses(first ?? [])).toMatchObject([{ sandboxed: false, reason: SANDBOX_OFF }]);
	});

	it("is not sent by a session without bash", async () => {
		const [first] = await turns(sandboxWith(), [[finished]], { tools: [] });
		expect(statuses(first ?? [])).toEqual([]);
	});

	it("carries the causes in the finished tool call", async () => {
		const sandbox = sandboxWith((command) => [{ command, line: "bash(7) deny(1) file-write-create /a/one" }]);
		const [first] = await turns(sandbox, [
			[{ toolCall: { tool: "bash", input: { command: failing }, callId: "c1" } }, finished],
		]);
		const done = first?.find((event) => event.type === "tool_call_finished");
		expect(done).toMatchObject({ ok: false, blocked: ["write to /a/one (not an allowed write path)"] });
	});
});
