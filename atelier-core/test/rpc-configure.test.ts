import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type AtelierEventBody,
	BACKEND_DEFAULTS,
	BACKEND_MODELS,
	decodeServerMessage,
	FakeBackend,
	type FakeStep,
	RpcServer,
	type RpcServerOptions,
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

function serve(
	turns: FakeStep[][] = [[{ event: finished }], [{ event: finished }]],
	configurable = true,
	extra: Partial<RpcServerOptions> = {},
) {
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
		...extra,
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
					{ name: "claude-code", default: BACKEND_DEFAULTS["claude-code"], models: [...BACKEND_MODELS["claude-code"]] },
					{
						name: "anthropic-api",
						default: BACKEND_DEFAULTS["anthropic-api"],
						models: [...BACKEND_MODELS["anthropic-api"]],
					},
					{ name: "opencode-go", default: BACKEND_DEFAULTS["opencode-go"], models: [...BACKEND_MODELS["opencode-go"]] },
					{
						name: "openai-codex",
						default: BACKEND_DEFAULTS["openai-codex"],
						models: [...BACKEND_MODELS["openai-codex"]],
					},
				],
				efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
				modes: ["normal", "auto", "yolo"],
				models: [],
				profiles: ["cheap", "deep"],
				active: "cheap",
			},
		});
		await h.close();
	});

	it("lists the models of the backends with a sign-in, each with its backend, from the catalog", async () => {
		const asked: string[] = [];
		const h = serve(undefined, true, {
			signedIn: async () => ["openai-codex", "claude-code"],
			catalog: {
				models: async (backend) => {
					asked.push(backend);
					return [`${backend}-one`, `${backend}-two`];
				},
			},
		});
		const response = await h.ask({ command: "options.list" });
		expect(response.ok && response.result.models).toEqual([
			{ provider: "claude-code", model: "claude-code-one" },
			{ provider: "claude-code", model: "claude-code-two" },
			{ provider: "openai-codex", model: "openai-codex-one" },
			{ provider: "openai-codex", model: "openai-codex-two" },
		]);
		expect(response.ok && response.result.backends).toContainEqual({
			name: "opencode-go",
			default: "minimax-m3",
			models: ["opencode-go-one", "opencode-go-two"],
		});
		expect(asked).toContain("anthropic-api");
		await h.close();
	});

	it("offers, from the dynamic catalog's cache, the code's models and the ones a provider listed, newest first", async () => {
		const { catalogFile, DynamicModelCatalog, ModelData, useModelData } = await import("../src/model-catalog/index.ts");
		const file = catalogFile(home);
		await mkdir(join(home, ".atelier"), { recursive: true });
		const listed = {
			checkedAt: Date.now(),
			models: { "openai-codex": [{ id: "gpt-6.1-terra" }, { id: "gpt-6-sol" }] },
		};
		await writeFile(file, JSON.stringify({ version: 1, sources: { "openai-codex": listed } }));
		const h = serve(undefined, true, {
			signedIn: async () => ["openai-codex"],
			catalog: new DynamicModelCatalog({ file, sources: [], network: false }),
		});
		const response = await h.ask({ command: "options.list" });
		const models = response.ok ? (response.result.models as { model: string }[]).map(({ model }) => model) : [];
		// 6.1 before 6, whether the code or the provider lists it.
		expect(models.indexOf("gpt-6.1-terra")).toBeLessThan(models.indexOf("gpt-6-sol"));
		expect(models.filter((model) => model === "gpt-6-sol")).toHaveLength(1);
		useModelData(new ModelData());
		await h.close();
	});

	it("offers a backend's list in the code when the catalog fails for it", async () => {
		const h = serve(undefined, true, {
			signedIn: async () => ["claude-code"],
			catalog: {
				models: async (backend) => {
					if (backend === "claude-code") throw new Error("broken cache");
					return ["x"];
				},
			},
		});
		const response = await h.ask({ command: "options.list" });
		expect(response.ok && response.result.backends).toContainEqual({
			name: "claude-code",
			default: "claude-opus-5-5",
			models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
		});
		expect(response.ok && response.result.models).toEqual([
			{ provider: "claude-code", model: "claude-opus-5-5" },
			{ provider: "claude-code", model: "claude-sonnet-5-5" },
			{ provider: "claude-code", model: "claude-haiku-5-5" },
		]);
		await h.close();
	});

	it("lists no models, and the rest as always, when the sign-ins cannot be read", async () => {
		const h = serve(undefined, true, { signedIn: () => Promise.reject(new Error("auth.json is not JSON")) });
		const response = await h.ask({ command: "options.list" });
		expect(response).toMatchObject({ ok: true, result: { models: [], modes: ["normal", "auto", "yolo"] } });
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

	it("says each backend's default, the model its backend runs without a choice, wherever it falls in the list", async () => {
		const { DEFAULT_MODEL, DEFAULT_API_MODEL } = await import("../src/index.ts");
		const { DEFAULT_OPENCODE_GO_MODEL } = await import("../src/backends/opencode-go/models.ts");
		const { DEFAULT_CODEX_MODEL } = await import("../src/backends/openai-codex/models.ts");
		const { catalogFile, DynamicModelCatalog } = await import("../src/model-catalog/index.ts");
		const file = catalogFile(home);
		await mkdir(join(home, ".atelier"), { recursive: true });
		// A newer model than the default, listed by the provider, comes first.
		const listed = { checkedAt: Date.now(), models: { "opencode-go": [{ id: "minimax-m9" }] } };
		await writeFile(file, JSON.stringify({ version: 1, sources: { "opencode-go": listed } }));
		const h = serve(undefined, true, { catalog: new DynamicModelCatalog({ file, sources: [], network: false }) });
		const response = await h.ask({ command: "options.list" });
		const backends = response.ok
			? (response.result.backends as { name: string; default: string; models: string[] }[])
			: [];
		expect(Object.fromEntries(backends.map(({ name, default: model }) => [name, model]))).toEqual({
			"claude-code": DEFAULT_MODEL,
			"anthropic-api": DEFAULT_API_MODEL,
			"opencode-go": DEFAULT_OPENCODE_GO_MODEL,
			"openai-codex": DEFAULT_CODEX_MODEL,
		});
		expect(backends.find(({ name }) => name === "opencode-go")?.models[0]).toBe("minimax-m9");
		await h.close();
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
