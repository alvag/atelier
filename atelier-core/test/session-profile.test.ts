import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AtelierEvent,
	type AtelierEventBody,
	BUILTIN_AGENTS,
	FakeBackend,
	type FakeStep,
	type FrozenProfile,
	freezeProfile,
	Session,
	type SessionOptions,
} from "../src/index.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
const finished: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
const text = (t: string): FakeStep => ({ event: { type: "text_delta", text: t } });
const task = (agent: "worker" | "explorer", callId: string): FakeStep => ({
	toolCall: { tool: "task", input: { agent, prompt: "do it" }, callId },
});

let base: string;
let home: string;

beforeEach(async () => {
	base = await realpath(await mkdtemp(join(tmpdir(), "atelier-session-profile-")));
	home = join(base, "home");
	await mkdir(join(home, ".atelier"), { recursive: true });
});
afterEach(() => rm(base, { recursive: true, force: true }));

/** Freezes the profile `p` of `profiles.json`, as the server does at `session.start`. */
async function freeze(entries: Record<string, unknown>): Promise<FrozenProfile> {
	await writeFile(
		join(home, ".atelier", "profiles.json"),
		JSON.stringify({ kind: "atelier.agent_model_profiles", version: 1, active: "p", profiles: { p: entries } }),
	);
	return freezeProfile({ cwd: base, home, pins: {}, choice: "p" });
}

async function drain(session: Session, prompt = "go"): Promise<AtelierEvent[]> {
	const events: AtelierEvent[] = [];
	for await (const event of session.send(prompt)) events.push(event);
	return events;
}

const configured = (events: AtelierEvent[]) => events.filter((event) => event.type === "session_configured");

async function start(turns: FakeStep[][], options: Partial<SessionOptions> = {}, configurable = true) {
	const backend = new FakeBackend(turns);
	backend.configurable = configurable;
	const session = await Session.start({ backend, cwd: base, tools: [], ...options });
	return { backend, session };
}

describe("Session.setProfile and the main agent", () => {
	it("gives the main agent the new orchestrator entry between turns, before the next prompt", async () => {
		const first = await freeze({ orchestrator: { model: "claude-opus-5-5", thinking: "high" } });
		const { backend, session } = await start([[{ event: finished }], [{ event: finished }]], { profile: first });
		await drain(session);
		const second = await freeze({ orchestrator: { model: "claude-sonnet-5-5", thinking: "low" } });
		const result = await session.setProfile(second);
		expect(result).toMatchObject({
			backend: "fake",
			model: "claude-sonnet-5-5",
			thinking: "low",
			profile: { name: "p", origin: "explicit", roles: {} },
			pending: false,
		});
		expect(backend.configured).toEqual([{ model: "claude-sonnet-5-5", thinking: "low" }]);
		await drain(session);
		expect(backend.calls).toEqual(["send", "configure", "send"]);
	});

	it("keeps a model the user chose at start, and changes only the level", async () => {
		const first = await freeze({ orchestrator: { thinking: "low" } });
		const { backend, session } = await start([[{ event: finished }]], { profile: first, model: "sonnet" });
		const second = await freeze({ orchestrator: { model: "claude-opus-5-5", thinking: "high" } });
		expect(await session.setProfile(second)).toMatchObject({ model: "sonnet", thinking: "high" });
		expect(backend.configured).toEqual([{ thinking: "high" }]);
	});

	it("keeps the model and the level the user chose with configure", async () => {
		const { backend, session } = await start([[{ event: finished }]], { profile: await freeze({}) });
		await session.configure({ model: "haiku" });
		await session.configure({ thinking: "max" });
		const second = await freeze({ orchestrator: { model: "claude-opus-5-5", thinking: "high" } });
		expect(await session.setProfile(second)).toMatchObject({ model: "haiku", thinking: "max" });
		expect(backend.configured).toEqual([{ model: "haiku" }, { thinking: "max" }]);
	});

	it("keeps the current model when the new orchestrator entry sets none", async () => {
		const first = await freeze({ orchestrator: { model: "claude-opus-5-5" } });
		const { backend, session } = await start([[{ event: finished }]], { profile: first });
		const second = await freeze({ verifier: { thinking: "low" } });
		expect(await session.setProfile(second)).toMatchObject({ model: "claude-opus-5-5" });
		expect(backend.configured).toEqual([]);
	});

	it("does not call the backend for a profile that leaves the main agent as it is", async () => {
		const { session } = await start([[{ event: finished }]], { profile: await freeze({}) }, false);
		const second = await freeze({ verifier: { model: "claude-sonnet-5-5" } });
		expect(await session.setProfile(second)).toMatchObject({
			profile: { roles: { verifier: { model: "claude-sonnet-5-5" } } },
			pending: false,
		});
	});

	it("works for a session that started without a profile", async () => {
		const { backend, session } = await start([[{ event: finished }]], { model: "sonnet" });
		const result = await session.setProfile(await freeze({ orchestrator: { thinking: "medium" } }));
		expect(result).toMatchObject({ model: "sonnet", thinking: "medium", profile: { name: "p" } });
		expect(backend.configured).toEqual([{ thinking: "medium" }]);
	});
});

describe("Session.setProfile and the roles that start later", () => {
	/** A parent that delegates to `agent` in each turn; `children` are the backends the factory built, in order. */
	async function delegating(agent: "worker" | "explorer", options: Partial<SessionOptions>, onChild?: () => void) {
		const children: FakeBackend[] = [];
		const { backend, session } = await start(
			[
				[task(agent, "c1"), { event: finished }],
				[task(agent, "c2"), { event: finished }],
			],
			{
				subagents: {
					agents: BUILTIN_AGENTS,
					createBackend: () => {
						onChild?.();
						const child = new FakeBackend([[text("report"), { event: finished }]]);
						children.push(child);
						return child;
					},
				},
				...options,
			},
		);
		return { backend, session, children };
	}

	it.each(["worker", "explorer"] as const)("starts the %s with the new profile's model and level", async (agent) => {
		const first = await freeze({ [agent]: { model: "claude-opus-5-5", thinking: "high" } });
		const { session, children } = await delegating(agent, { profile: first });
		await drain(session);
		await session.setProfile(await freeze({ [agent]: { model: "claude-sonnet-5-5", thinking: "low" } }));
		await drain(session);
		await session.close();
		expect(children[0]?.startOptions).toMatchObject({ model: "claude-opus-5-5", thinking: "high" });
		expect(children[1]?.startOptions).toMatchObject({ model: "claude-sonnet-5-5", thinking: "low" });
	});

	it("hands the new compaction entry to the next child, and drops the old one", async () => {
		const first = await freeze({ compaction: { model: "claude-haiku-5-5" }, worker: {} });
		const { session, children } = await delegating("worker", { profile: first });
		await drain(session);
		await session.setProfile(await freeze({ compaction: { model: "claude-sonnet-5-5", thinking: "low" } }));
		await drain(session);
		await session.close();
		expect(children[0]?.startOptions?.compaction).toEqual({ model: "claude-haiku-5-5" });
		expect(children[1]?.startOptions?.compaction).toEqual({ model: "claude-sonnet-5-5", thinking: "low" });
	});

	it("tells the main backend the new compaction entry, and clears it when the profile sets none", async () => {
		const first = await freeze({ compaction: { model: "claude-haiku-5-5" } });
		const { backend, session } = await start([[{ event: finished }]], { profile: first });
		await session.setProfile(await freeze({ compaction: { model: "claude-sonnet-5-5", thinking: "low" } }));
		await session.setProfile(await freeze({ compaction: { model: "claude-sonnet-5-5", thinking: "low" } }));
		await session.setProfile(await freeze({ verifier: { thinking: "low" } }));
		expect(backend.configured).toEqual([
			{ compaction: { model: "claude-sonnet-5-5", thinking: "low" } },
			{ compaction: null },
		]);
	});

	it("lets a turn already running finish with the previous profile, and holds the change until it ends", async () => {
		const first = await freeze({ worker: { model: "claude-opus-5-5" }, orchestrator: { model: "claude-opus-5-5" } });
		const second = await freeze({
			worker: { model: "claude-sonnet-5-5" },
			orchestrator: { model: "claude-sonnet-5-5" },
		});
		let held: unknown;
		let asked = 0;
		const { backend, session, children } = await delegating("worker", { profile: first }, () => {
			// The first child starts in the middle of the first turn: the change asked there waits.
			if (asked++ === 0) held = session.setProfile(second);
		});
		const events = await drain(session);
		expect(await held).toMatchObject({ model: "claude-sonnet-5-5", pending: true });
		expect(backend.configured).toEqual([{ model: "claude-sonnet-5-5" }]);
		expect(children[0]?.startOptions?.model).toBe("claude-opus-5-5");
		// The configuration is said in the turn that applied it, before its closing event.
		expect(events.map((event) => event.type).slice(-2)).toEqual(["session_configured", "turn_finished"]);
		expect(configured(events)).toMatchObject([{ model: "claude-sonnet-5-5", profile: { name: "p" } }]);
		await drain(session);
		await session.close();
		expect(children[1]?.startOptions?.model).toBe("claude-sonnet-5-5");
	});

	it("keeps a model chosen during the turn over the held profile's, whichever came first", async () => {
		const { backend, session } = await start([[{ waitForInterrupt: true }]], {
			profile: await freeze({ orchestrator: { model: "claude-opus-5-5" } }),
		});
		const running = drain(session);
		for (let i = 0; i < 200 && !session.busy; i++) await new Promise((resolve) => setTimeout(resolve, 1));
		const second = await freeze({ orchestrator: { model: "claude-sonnet-5-5", thinking: "low" } });
		await session.setProfile(second);
		expect(await session.configure({ model: "haiku" })).toMatchObject({
			model: "haiku",
			thinking: "low",
			pending: true,
		});
		await session.interrupt();
		await running;
		expect(backend.configured).toEqual([{ thinking: "low", model: "haiku" }]);
	});

	it("holds two profiles asked in one turn and applies the last", async () => {
		const { backend, session } = await start([[{ waitForInterrupt: true }]], { profile: await freeze({}) });
		const running = drain(session);
		for (let i = 0; i < 200 && !session.busy; i++) await new Promise((resolve) => setTimeout(resolve, 1));
		await session.setProfile(await freeze({ orchestrator: { model: "claude-opus-5-5" } }));
		await session.setProfile(await freeze({ orchestrator: { model: "claude-sonnet-5-5" } }));
		await session.interrupt();
		await running;
		expect(backend.configured).toEqual([{ model: "claude-sonnet-5-5" }]);
	});
});

describe("Session.setProfile refusals", () => {
	it("refuses a profile whose orchestrator runs on another backend, and changes nothing", async () => {
		const first = await freeze({ orchestrator: { model: "claude-opus-5-5" } });
		const { backend, session } = await start([[{ event: finished }]], { profile: first });
		const other = await freeze({ orchestrator: { model: "anthropic-api/claude-sonnet-5-5", thinking: "low" } });
		await expect(session.setProfile(other)).rejects.toMatchObject({
			code: "profile_backend_change",
			message:
				'Profile "p" runs the orchestrator on anthropic-api, but this session runs on fake; the backend of an open session does not change with the profile.',
		});
		expect(backend.configured).toEqual([]);
		expect(session.configuration()).toMatchObject({
			model: "claude-opus-5-5",
			profile: { roles: {} },
			pending: false,
		});
		const events = await drain(session);
		expect(configured(events)).toEqual([]);
	});

	it("accepts an orchestrator entry that names the session's own backend", async () => {
		const { backend, session } = await start([[{ event: finished }]]);
		Object.defineProperty(backend, "id", { value: "claude-code" });
		const same = await freeze({ orchestrator: { model: "claude-code/haiku" } });
		expect(await session.setProfile(same)).toMatchObject({ backend: "claude-code", model: "haiku" });
	});

	it("refuses a backend change asked during a turn at once, holding nothing", async () => {
		const { backend, session } = await start([[{ waitForInterrupt: true }]]);
		const running = drain(session);
		for (let i = 0; i < 200 && !session.busy; i++) await new Promise((resolve) => setTimeout(resolve, 1));
		const other = await freeze({ orchestrator: { model: "anthropic-api/claude-sonnet-5-5" } });
		await expect(session.setProfile(other)).rejects.toMatchObject({ code: "profile_backend_change" });
		expect(session.configuration().pending).toBe(false);
		await session.interrupt();
		expect(configured(await running)).toEqual([]);
		expect(backend.configured).toEqual([]);
	});

	it("refuses when the backend cannot change the main agent and the profile would, leaving the old profile", async () => {
		const first = await freeze({ verifier: { thinking: "low" } });
		const { session } = await start([[{ event: finished }]], { profile: first }, false);
		const second = await freeze({ orchestrator: { thinking: "high" } });
		await expect(session.setProfile(second)).rejects.toMatchObject({ code: "configure_unsupported" });
		expect(session.configuration().profile).toEqual({
			name: "p",
			origin: "explicit",
			roles: { verifier: { thinking: "low" } },
		});
	});

	it("keeps the old profile and configuration when the backend rejects the change", async () => {
		const first = await freeze({ orchestrator: { model: "claude-opus-5-5" }, verifier: { thinking: "low" } });
		const backend = new FakeBackend([[{ event: finished }]]);
		const failing: FakeBackend = Object.assign(backend, {
			async start(options: Parameters<FakeBackend["start"]>[0]) {
				const inner = await FakeBackend.prototype.start.call(backend, options);
				return {
					...inner,
					async configure() {
						throw new Error("no such model");
					},
				};
			},
		});
		const session = await Session.start({ backend: failing, cwd: base, tools: [], profile: first });
		await expect(session.setProfile(await freeze({ orchestrator: { model: "nope" } }))).rejects.toMatchObject({
			code: "configure_failed",
			message: "no such model",
		});
		expect(session.configuration()).toMatchObject({
			model: "claude-opus-5-5",
			profile: { roles: { verifier: { thinking: "low" } } },
		});
		expect(configured(await drain(session))).toEqual([]);
	});

	it("is refused on a closed session", async () => {
		const { session } = await start([]);
		await session.close();
		await expect(session.setProfile(await freeze({}))).rejects.toMatchObject({ code: "session_closed" });
	});
});

describe("the event and the notices", () => {
	it("says the new profile in the first event of the next turn, once", async () => {
		const { session } = await start([[{ event: finished }], [{ event: finished }], [{ event: finished }]], {
			profile: await freeze({}),
		});
		await drain(session);
		await session.setProfile(
			await freeze({ verifier: { model: "anthropic-api/claude-sonnet-5-5", thinking: "medium" } }),
		);
		const second = await drain(session);
		expect(second[0]).toMatchObject({
			type: "session_configured",
			backend: "fake",
			permissionMode: "normal",
			profile: {
				name: "p",
				origin: "explicit",
				roles: { verifier: { backend: "anthropic-api", model: "claude-sonnet-5-5", thinking: "medium" } },
			},
		});
		expect(configured(await drain(session))).toEqual([]);
	});

	it("reports what the new profile dropped once, in the next turn", async () => {
		const { session } = await start([[{ event: finished }], [{ event: finished }], [{ event: finished }]], {
			profile: await freeze({}),
		});
		await drain(session);
		await session.setProfile(await freeze({ verifer: { model: "x" } }));
		const second = await drain(session);
		const warnings = second.flatMap((event) => (event.type === "error" ? [[event.code, event.message]] : []));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.[0]).toBe("profile_warning");
		expect(warnings[0]?.[1]).toContain('unknown role "verifer", did you mean "verifier"?');
		const third = await drain(session);
		expect(third.filter((event) => event.type === "error")).toEqual([]);
	});

	it("watches the files of the new profile, not the old one's", async () => {
		const { session } = await start([[{ event: finished }], [{ event: finished }], [{ event: finished }]], {
			profile: await freeze({}),
		});
		await drain(session);
		await session.setProfile(await freeze({ verifier: { thinking: "low" } }));
		// The file changed before the freeze: no change is reported against the new profile.
		const second = await drain(session);
		expect(second.filter((event) => event.type === "error")).toEqual([]);
		await freeze({ verifier: { thinking: "high" } });
		const third = await drain(session);
		expect(third.flatMap((event) => (event.type === "error" ? [event.code] : []))).toEqual(["profile_changed"]);
	});
});
