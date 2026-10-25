import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type AtelierEvent,
	type AtelierEventBody,
	type BackendName,
	BUILTIN_AGENTS,
	FakeBackend,
	type FakeStep,
	type FrozenProfile,
	freezeProfile,
	MissingApiKeyError,
	Session,
	type SessionOptions,
} from "../src/index.ts";
import { defineTool } from "../src/tools/types.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const text = (t: string): FakeStep => ({ event: { type: "text_delta", text: t } });

let base: string;
let home: string;

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-profile-session-")));
	home = join(base, "home");
	await mkdir(join(home, ".atelier"), { recursive: true });
});
afterEach(() => rm(base, { recursive: true, force: true }));

/** Freezes the profile `profiles.json` holds, with no pins. */
async function freeze(profiles: Record<string, unknown>, active = "p"): Promise<FrozenProfile> {
	await writeFile(
		join(home, ".atelier", "profiles.json"),
		JSON.stringify({ kind: "atelier.agent_model_profiles", version: 1, active, profiles }),
	);
	return freezeProfile({ cwd: base, home, pins: {} });
}

const tools = ["read", "grep", "edit", "bash"].map((name) =>
	defineTool({
		name,
		description: name,
		inputShape: { path: z.string().optional() },
		execute: async () => ({ ok: true, output: `${name} ran`, summary: name, truncated: false }),
	}),
);

async function drain(session: Session, prompt = "go"): Promise<AtelierEvent[]> {
	const events: AtelierEvent[] = [];
	for await (const event of session.send(prompt)) events.push(event);
	return events;
}

/** A parent that calls `task` for `agent`, and the children each factory call built; `make` may refuse a backend. */
async function delegate(
	options: Partial<SessionOptions>,
	agent: "worker" | "explorer",
	make: (name: BackendName | undefined) => FakeBackend = () => new FakeBackend([[text("report"), { event: finished }]]),
) {
	const parent = new FakeBackend([
		[{ toolCall: { tool: "task", input: { agent, prompt: "do it" }, callId: "c1" } }, { event: finished }],
	]);
	const created: { name: BackendName | undefined; backend: FakeBackend }[] = [];
	const session = await Session.start({
		backend: parent,
		cwd: base,
		tools,
		model: "session-model",
		subagents: {
			agents: BUILTIN_AGENTS,
			createBackend: (name) => {
				const backend = make(name);
				created.push({ name, backend });
				return backend;
			},
		},
		...options,
	});
	try {
		await drain(session);
	} finally {
		await session.close();
	}
	return { parent, created, result: parent.toolResults[0] };
}

describe("a session without a profile", () => {
	it("starts the main agent and the subagents as it always did", async () => {
		const { parent, created } = await delegate({}, "explorer");
		expect(parent.startOptions?.model).toBe("session-model");
		expect(parent.startOptions).not.toHaveProperty("thinking");
		expect(parent.startOptions).not.toHaveProperty("compaction");
		expect(created.map((c) => c.name)).toEqual([undefined]);
		expect(created[0]?.backend.startOptions?.model).toBe("session-model");
		expect(created[0]?.backend.startOptions).not.toHaveProperty("thinking");
	});

	it("says nothing about profiles", async () => {
		const session = await Session.start({ backend: new FakeBackend([[{ event: finished }]]), cwd: base, tools });
		const events = await drain(session);
		await session.close();
		expect(events.filter((e) => e.type === "error")).toEqual([]);
	});
});

describe("the orchestrator", () => {
	it("gives the main agent its model and thinking level", async () => {
		const profile = await freeze({ p: { orchestrator: { model: "claude-opus-5-5", thinking: "high" } } });
		const backend = new FakeBackend([[{ event: finished }]]);
		const session = await Session.start({ backend, cwd: base, tools, profile });
		await drain(session);
		await session.close();
		expect(backend.startOptions).toMatchObject({ model: "claude-opus-5-5", thinking: "high" });
	});

	it("lets an explicit model win over the orchestrator's, and keeps its thinking level", async () => {
		const profile = await freeze({ p: { orchestrator: { model: "claude-opus-5-5", thinking: "high" } } });
		const backend = new FakeBackend([]);
		await (await Session.start({ backend, cwd: base, tools, profile, model: "sonnet" })).close();
		expect(backend.startOptions).toMatchObject({ model: "sonnet", thinking: "high" });
	});

	it("keeps the session's model when the orchestrator sets none", async () => {
		const profile = await freeze({ p: { orchestrator: { thinking: "low" } } });
		const backend = new FakeBackend([]);
		await (await Session.start({ backend, cwd: base, tools, profile, model: "sonnet" })).close();
		expect(backend.startOptions).toMatchObject({ model: "sonnet", thinking: "low" });
	});
});

describe("the warnings at session start", () => {
	it("reports what resolution dropped as recoverable errors in the first turn only", async () => {
		const profile = await freeze({ p: { verifer: { model: "x" }, worker: { thinking: "huge" } } });
		const backend = new FakeBackend([[{ event: finished }], [{ event: finished }]]);
		const session = await Session.start({ backend, cwd: base, tools, profile });
		const first = await drain(session);
		const second = await drain(session);
		await session.close();
		const warnings = first.filter((e) => e.type === "error");
		expect(warnings.map((e) => e.type === "error" && [e.code, e.recoverable])).toEqual([
			["profile_warning", true],
			["profile_warning", true],
		]);
		const messages = warnings.map((e) => (e.type === "error" ? e.message : ""));
		expect(messages[0]).toContain(`${home}/.atelier/profiles.json`);
		expect(messages[0]).toContain('unknown role "verifer", did you mean "verifier"?');
		expect(messages[1]).toContain("unknown level for thinking");
		expect(second.filter((e) => e.type === "error")).toEqual([]);
	});
});

describe("the subagents", () => {
	it("start the worker on the backend, model and thinking its entry names", async () => {
		const profile = await freeze({
			p: { worker: { model: "claude-code/claude-opus-5-5", thinking: "medium" } },
		});
		const { created, result } = await delegate({ profile }, "worker");
		expect(result?.ok).toBe(true);
		expect(created.map((c) => c.name)).toEqual(["claude-code"]);
		expect(created[0]?.backend.startOptions).toMatchObject({ model: "claude-opus-5-5", thinking: "medium" });
	});

	it("keep the session's model for a worker the profile does not name", async () => {
		const profile = await freeze({ p: { verifier: { thinking: "low" } } });
		const { created } = await delegate({ profile }, "worker");
		expect(created.map((c) => c.name)).toEqual([undefined]);
		expect(created[0]?.backend.startOptions?.model).toBe("session-model");
		expect(created[0]?.backend.startOptions).not.toHaveProperty("thinking");
	});

	it("start the explorer on its haiku default unless the profile sets a model", async () => {
		const plain = await delegate(
			{ profile: await freeze({ p: { explorer: { thinking: "low" } } }) },
			"explorer",
			() => {
				const backend = new FakeBackend([[text("report"), { event: finished }]]);
				Object.defineProperty(backend, "id", { value: "claude-code" });
				return backend;
			},
		);
		expect(plain.created[0]?.backend.startOptions).toMatchObject({ model: "haiku", thinking: "low" });
		const own = await delegate(
			{ profile: await freeze({ p: { explorer: { model: "claude-sonnet-5-5" } } }) },
			"explorer",
		);
		expect(own.created[0]?.backend.startOptions?.model).toBe("claude-sonnet-5-5");
	});

	it("name the backend of a role that starts but fails, as Claude Code does without a login", async () => {
		const profile = await freeze({ p: { explorer: { model: "claude-code/haiku" } } });
		const { result } = await delegate({ profile }, "explorer", () => new FakeBackend([[{ throw: "Not logged in" }]]));
		expect(result?.ok).toBe(false);
		expect(result?.output).toMatch(
			/^The explorer subagent failed on claude-code \(error\): backend_error: Not logged in/,
		);
	});

	it("fail the role when its backend has no credential, naming the role and the backend, without a retry", async () => {
		const profile = await freeze({ p: { worker: { model: "anthropic-api/claude-opus-5-5" } } });
		const names: (BackendName | undefined)[] = [];
		const parent = new FakeBackend([
			[{ toolCall: { tool: "task", input: { agent: "worker", prompt: "do it" }, callId: "c1" } }, { event: finished }],
		]);
		const session = await Session.start({
			backend: parent,
			cwd: base,
			tools,
			profile,
			subagents: {
				agents: BUILTIN_AGENTS,
				createBackend: (name) => {
					names.push(name);
					throw new MissingApiKeyError("No Anthropic API key. Set ANTHROPIC_API_KEY for this command.");
				},
			},
		});
		await drain(session);
		await session.close();
		expect(names).toEqual(["anthropic-api"]);
		expect(parent.toolResults[0]).toEqual({
			ok: false,
			output: "worker: anthropic-api has no API key (No Anthropic API key. Set ANTHROPIC_API_KEY for this command.)",
		});
	});
});
