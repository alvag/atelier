import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AtelierEventBody,
	BACKEND_MODELS,
	decodeServerMessage,
	FakeBackend,
	type FakeStep,
	RpcServer,
	type ServerMessage,
} from "../src/index.ts";

const finished: AtelierEventBody = {
	type: "turn_finished",
	stopReason: "end_turn",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "atelier-rpc-configure-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

function serve(turns: FakeStep[][] = [[{ event: finished }], [{ event: finished }]], configurable = true) {
	const input = new PassThrough();
	const messages: ServerMessage[] = [];
	const backends: FakeBackend[] = [];
	const server = new RpcServer({
		input,
		write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
		createBackend: () => {
			const backend = new FakeBackend(turns);
			backend.configurable = configurable;
			backends.push(backend);
			return backend;
		},
		tools: [],
		systemPromptAppend: "",
		home,
	});
	const done = server.run();
	let next = 0;
	const ask = async (command: Record<string, unknown>) => {
		const id = `c${++next}`;
		input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
		for (let i = 0; i < 400; i++) {
			const found = messages.find((m) => m.type === "response" && m.id === id);
			if (found) return found as Extract<ServerMessage, { type: "response" }>;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`No response to ${id}`);
	};
	const eventsOf = (sessionId: string) =>
		messages.flatMap((m) => (m.type === "event" && m.sessionId === sessionId ? [m.event] : []));
	const open = async (extra: Record<string, unknown> = {}) => {
		const response = await ask({ command: "session.start", cwd: home, ...extra });
		return (response as unknown as { result: { sessionId: string } }).result.sessionId;
	};
	/** Runs a turn to its end and returns the events it produced. */
	const turn = async (sessionId: string) => {
		const before = eventsOf(sessionId).filter((e) => e.type === "turn_finished").length;
		expect((await ask({ command: "session.send", sessionId, prompt: "hi" })).ok).toBe(true);
		for (let i = 0; i < 400 && eventsOf(sessionId).filter((e) => e.type === "turn_finished").length === before; i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		return eventsOf(sessionId);
	};
	const close = () => {
		input.end();
		return done;
	};
	return { ask, open, turn, eventsOf, backends, close };
}

describe("session.set_model and session.set_effort", () => {
	it("session.start answers the configuration the first turn runs with", async () => {
		const h = serve();
		const response = await h.ask({ command: "session.start", cwd: home, model: "opus", mode: "auto" });
		expect(response).toMatchObject({
			ok: true,
			result: { configuration: { backend: "fake", model: "opus", permissionMode: "auto", pending: false } },
		});
		await h.close();
	});

	it("session.set_model answers the resulting configuration and the next turn runs with it", async () => {
		const h = serve();
		const sessionId = await h.open({ model: "opus" });
		const response = await h.ask({ command: "session.set_model", sessionId, model: "sonnet" });
		expect(response).toMatchObject({
			ok: true,
			result: { backend: "fake", model: "sonnet", permissionMode: "normal", pending: false },
		});
		const events = await h.turn(sessionId);
		expect(h.backends[0]?.configured).toEqual([{ model: "sonnet" }]);
		expect(events.find((e) => e.type === "session_configured")).toMatchObject({
			backend: "fake",
			model: "sonnet",
			permissionMode: "normal",
		});
		await h.close();
	});

	it("session.set_effort answers the resulting configuration, with the level as the session names it", async () => {
		const h = serve();
		const sessionId = await h.open();
		const response = await h.ask({ command: "session.set_effort", sessionId, effort: "xhigh" });
		expect(response).toMatchObject({ ok: true, result: { backend: "fake", thinking: "xhigh", pending: false } });
		await h.turn(sessionId);
		expect(h.backends[0]?.configured).toEqual([{ thinking: "xhigh" }]);
		await h.close();
	});

	it("answers a change asked during a turn as pending and applies it when the turn ends", async () => {
		const h = serve([[{ waitForInterrupt: true }]]);
		const sessionId = await h.open({ model: "opus" });
		await h.ask({ command: "session.send", sessionId, prompt: "go" });
		const response = await h.ask({ command: "session.set_model", sessionId, model: "haiku" });
		expect(response).toMatchObject({ ok: true, result: { model: "haiku", pending: true } });
		expect(h.backends[0]?.configured).toEqual([]);
		await h.ask({ command: "session.interrupt", sessionId });
		for (let i = 0; i < 400 && !h.eventsOf(sessionId).some((e) => e.type === "turn_finished"); i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(h.backends[0]?.configured).toEqual([{ model: "haiku" }]);
		expect(
			h
				.eventsOf(sessionId)
				.map((e) => e.type)
				.slice(-2),
		).toEqual(["session_configured", "turn_finished"]);
		await h.close();
	});

	it("says the mode change in the next turn as well", async () => {
		const h = serve();
		const sessionId = await h.open();
		await h.ask({ command: "session.set_mode", sessionId, mode: "yolo" });
		expect(await h.turn(sessionId)).toContainEqual(
			expect.objectContaining({ type: "session_configured", permissionMode: "yolo" }),
		);
		await h.close();
	});

	it("answers an unknown session like the other session commands", async () => {
		const h = serve();
		for (const command of [
			{ command: "session.set_model", sessionId: "nope", model: "sonnet" },
			{ command: "session.set_effort", sessionId: "nope", effort: "high" },
		])
			expect(await h.ask(command)).toMatchObject({
				ok: false,
				error: { code: "unknown_session", message: "No session nope." },
			});
		await h.close();
	});

	it("answers a clear error when the backend cannot change an open session, and changes nothing", async () => {
		const h = serve([[{ event: finished }]], false);
		const sessionId = await h.open({ model: "opus" });
		expect(await h.ask({ command: "session.set_model", sessionId, model: "sonnet" })).toMatchObject({
			ok: false,
			error: {
				code: "configure_unsupported",
				message: "The fake backend cannot change the model or the effort of an open session.",
			},
		});
		expect(await h.turn(sessionId)).not.toContainEqual(expect.objectContaining({ type: "session_configured" }));
		await h.close();
	});

	it("answers invalid input as invalid_command, by id", async () => {
		const h = serve();
		const sessionId = await h.open();
		expect(await h.ask({ command: "session.set_effort", sessionId, effort: "turbo" })).toMatchObject({
			ok: false,
			error: { code: "invalid_command" },
		});
		expect(await h.ask({ command: "session.set_model", sessionId, model: "" })).toMatchObject({
			ok: false,
			error: { code: "invalid_command" },
		});
		await h.close();
	});
});

describe("options.list", () => {
	it("lists the backends with their models, the effort levels, the modes and the profiles", async () => {
		await mkdir(join(home, ".atelier"), { recursive: true });
		await writeFile(
			join(home, ".atelier", "profiles.json"),
			JSON.stringify({
				kind: "atelier.agent_model_profiles",
				version: 1,
				active: "cheap",
				profiles: { cheap: { orchestrator: { model: "haiku" } }, deep: {} },
			}),
		);
		const h = serve();
		const response = await h.ask({ command: "options.list" });
		expect(response).toEqual({
			type: "response",
			id: expect.any(String),
			ok: true,
			result: {
				backends: [
					{ name: "claude-code", models: [...BACKEND_MODELS["claude-code"]] },
					{ name: "anthropic-api", models: [...BACKEND_MODELS["anthropic-api"]] },
					{ name: "opencode-go", models: [...BACKEND_MODELS["opencode-go"]] },
				],
				efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
				modes: ["normal", "auto", "yolo"],
				profiles: ["cheap", "deep"],
				active: "cheap",
			},
		});
		await h.close();
	});

	it("says the profile a session in cwd would take, like profiles.list", async () => {
		const h = serve();
		const listed = await h.ask({ command: "profiles.list", cwd: home });
		const options = await h.ask({ command: "options.list", cwd: home });
		expect(listed.ok && options.ok && options.result.effective).toEqual(listed.ok && listed.result.effective);
		expect(options.ok && options.result.effective).toBeDefined();
		await h.close();
	});

	it("lists the first model of each backend as the default one the backends use", async () => {
		const { DEFAULT_MODEL, DEFAULT_API_MODEL } = await import("../src/index.ts");
		expect(BACKEND_MODELS["claude-code"][0]).toBe(DEFAULT_MODEL);
		expect(BACKEND_MODELS["anthropic-api"][0]).toBe(DEFAULT_API_MODEL);
	});
});

describe("session.set_profile", () => {
	async function profiles(entries: Record<string, Record<string, unknown>>, active?: string) {
		await mkdir(join(home, ".atelier"), { recursive: true });
		await writeFile(
			join(home, ".atelier", "profiles.json"),
			JSON.stringify({
				kind: "atelier.agent_model_profiles",
				version: 1,
				...(active === undefined ? {} : { active }),
				profiles: entries,
			}),
		);
	}

	it("freezes the named profile and answers the resulting configuration; the next turn runs with it", async () => {
		await profiles({
			cheap: { orchestrator: { model: "haiku", thinking: "low" }, verifier: { thinking: "low" } },
			deep: { orchestrator: { model: "opus", thinking: "high" } },
		});
		const h = serve();
		const sessionId = await h.open({ profile: "cheap" });
		const response = await h.ask({ command: "session.set_profile", sessionId, profile: "deep" });
		expect(response).toMatchObject({
			ok: true,
			result: {
				backend: "fake",
				model: "opus",
				thinking: "high",
				permissionMode: "normal",
				profile: { name: "deep", origin: "explicit", roles: {} },
				pending: false,
			},
		});
		const events = await h.turn(sessionId);
		expect(h.backends[0]?.configured).toEqual([{ model: "opus", thinking: "high" }]);
		expect(events.find((e) => e.type === "session_configured")).toMatchObject({
			model: "opus",
			thinking: "high",
			profile: { name: "deep", origin: "explicit", roles: {} },
		});
		await h.close();
	});

	it("keeps a model given to session.start and one set with session.set_model", async () => {
		await profiles({ deep: { orchestrator: { model: "opus", thinking: "high" } } });
		const h = serve();
		const started = await h.open({ model: "sonnet" });
		expect(await h.ask({ command: "session.set_profile", sessionId: started, profile: "deep" })).toMatchObject({
			ok: true,
			result: { model: "sonnet", thinking: "high" },
		});
		const chosen = await h.open();
		await h.ask({ command: "session.set_effort", sessionId: chosen, effort: "low" });
		expect(await h.ask({ command: "session.set_profile", sessionId: chosen, profile: "deep" })).toMatchObject({
			ok: true,
			result: { model: "opus", thinking: "low" },
		});
		await h.close();
	});

	it("answers a change asked during a turn as pending and applies it when the turn ends", async () => {
		await profiles({ deep: { orchestrator: { model: "opus" } } });
		const h = serve([[{ waitForInterrupt: true }]]);
		const sessionId = await h.open();
		await h.ask({ command: "session.send", sessionId, prompt: "go" });
		const response = await h.ask({ command: "session.set_profile", sessionId, profile: "deep" });
		expect(response).toMatchObject({ ok: true, result: { model: "opus", profile: { name: "deep" }, pending: true } });
		expect(h.backends[0]?.configured).toEqual([]);
		await h.ask({ command: "session.interrupt", sessionId });
		for (let i = 0; i < 400 && !h.eventsOf(sessionId).some((e) => e.type === "turn_finished"); i++)
			await new Promise((resolve) => setTimeout(resolve, 5));
		expect(h.backends[0]?.configured).toEqual([{ model: "opus" }]);
		expect(
			h
				.eventsOf(sessionId)
				.map((e) => e.type)
				.slice(-2),
		).toEqual(["session_configured", "turn_finished"]);
		await h.close();
	});

	it("refuses a profile it cannot find, suggesting the nearest name, and changes nothing", async () => {
		await profiles({ cheap: { orchestrator: { model: "haiku" } } }, "cheap");
		const h = serve();
		const sessionId = await h.open();
		expect(await h.ask({ command: "session.set_profile", sessionId, profile: "chaep" })).toMatchObject({
			ok: false,
			error: {
				code: "unknown_profile",
				message: 'No profile "chaep" in ~/.atelier/profiles.json; did you mean "cheap"?',
			},
		});
		expect(await h.ask({ command: "session.set_profile", sessionId, profile: "gone" })).toMatchObject({
			ok: false,
			error: { code: "unknown_profile", message: 'No profile "gone" in ~/.atelier/profiles.json.' },
		});
		expect(await h.turn(sessionId)).not.toContainEqual(expect.objectContaining({ type: "session_configured" }));
		expect(h.backends[0]?.configured).toEqual([]);
		await h.close();
	});

	it("refuses a profile that moves the orchestrator to another backend, and changes nothing", async () => {
		await profiles({ api: { orchestrator: { model: "anthropic-api/claude-opus-5-5" } } });
		const h = serve();
		const sessionId = await h.open();
		expect(await h.ask({ command: "session.set_profile", sessionId, profile: "api" })).toMatchObject({
			ok: false,
			error: { code: "profile_backend_change" },
		});
		expect(await h.turn(sessionId)).not.toContainEqual(expect.objectContaining({ type: "session_configured" }));
		expect(h.backends[0]?.configured).toEqual([]);
		await h.close();
	});

	it("answers an unknown session, and invalid input by id", async () => {
		const h = serve();
		expect(await h.ask({ command: "session.set_profile", sessionId: "nope", profile: "deep" })).toMatchObject({
			ok: false,
			error: { code: "unknown_session", message: "No session nope." },
		});
		expect(await h.ask({ command: "session.set_profile", sessionId: "nope", profile: "" })).toMatchObject({
			ok: false,
			error: { code: "invalid_command" },
		});
		await h.close();
	});

	it("refuses with profile_unavailable on a server that reads no profiles", async () => {
		const input = new PassThrough();
		const messages: ServerMessage[] = [];
		const server = new RpcServer({
			input,
			write: (line) => messages.push(decodeServerMessage(line.trimEnd()) as ServerMessage),
			createBackend: () => new FakeBackend([[{ event: finished }]]),
			tools: [],
			systemPromptAppend: "",
		});
		const done = server.run();
		const send = async (id: string, command: Record<string, unknown>) => {
			input.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
			for (let i = 0; i < 400 && !messages.some((m) => m.type === "response" && m.id === id); i++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			return messages.find((m) => m.type === "response" && m.id === id);
		};
		const started = (await send("a", { command: "session.start", cwd: home })) as unknown as {
			result: { sessionId: string };
		};
		expect(
			await send("b", { command: "session.set_profile", sessionId: started.result.sessionId, profile: "deep" }),
		).toMatchObject({ ok: false, error: { code: "profile_unavailable" } });
		input.end();
		await done;
	});
});
