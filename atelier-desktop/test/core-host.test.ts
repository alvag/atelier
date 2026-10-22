import type { CoreExit } from "@atelier/core/client";
import type { AtelierEvent, ClientCommand } from "@atelier/core/protocol";
import { describe, expect, it } from "vitest";
import { type CoreConnection, CoreHost } from "../src/main/core-host.ts";
import type { HostMessage } from "../src/shared/bridge.ts";

class FakeConnection implements CoreConnection {
	readonly coreVersion = "9.9.9";
	readonly requests: ClientCommand[] = [];
	closed = false;
	answer: (command: ClientCommand) => Promise<Record<string, string>> = async () => ({});
	#event = (_sessionId: string, _event: AtelierEvent) => {};
	#protocolError = (_message: string) => {};
	#exit = (_exit: CoreExit) => {};

	request(command: ClientCommand) {
		this.requests.push(command);
		return this.answer(command);
	}
	onEvent(listener: (sessionId: string, event: AtelierEvent) => void) {
		this.#event = listener;
		return () => {};
	}
	onProtocolError(listener: (message: string) => void) {
		this.#protocolError = listener;
		return () => {};
	}
	onExit(listener: (exit: CoreExit) => void) {
		this.#exit = listener;
		return () => {};
	}
	async close() {
		this.closed = true;
		this.#exit({ code: 0, signal: null, stderr: "" });
	}
	emitEvent(sessionId: string, event: AtelierEvent) {
		this.#event(sessionId, event);
	}
	emitProtocolError(message: string) {
		this.#protocolError(message);
	}
	crash(exit: CoreExit) {
		this.#exit(exit);
	}
}

function harness(connect?: () => Promise<CoreConnection>) {
	const sent: HostMessage[] = [];
	const connections: FakeConnection[] = [];
	const host = new CoreHost({
		connect:
			connect ??
			(async () => {
				const connection = new FakeConnection();
				connections.push(connection);
				return connection;
			}),
		send: (message) => sent.push(message),
	});
	return { host, sent, connections };
}

describe("CoreHost", () => {
	it("announces the core version when it starts", async () => {
		const h = harness();
		await h.host.start();
		expect(h.sent).toEqual([{ type: "core_ready", version: "9.9.9" }]);
	});

	it("reports a core that cannot start", async () => {
		const h = harness(async () => {
			throw Object.assign(new Error("spawn node ENOENT"), { code: "core_exited" });
		});
		await h.host.start();
		expect(h.sent).toEqual([{ type: "core_failed", message: "spawn node ENOENT" }]);
		expect(await h.host.request({ command: "shutdown" })).toEqual({
			ok: false,
			error: { code: "core_unavailable", message: "The core is not running." },
		});
	});

	it("forwards requests and turns failures into results, never throwing", async () => {
		const h = harness();
		await h.host.start();
		const connection = h.connections[0] as FakeConnection;
		connection.answer = async (command) => {
			if (command.command === "session.start") return { sessionId: "s1" };
			throw Object.assign(new Error("No session nope."), { code: "unknown_session" });
		};
		expect(await h.host.request({ command: "session.start", cwd: "/w" })).toEqual({
			ok: true,
			result: { sessionId: "s1" },
		});
		expect(await h.host.request({ command: "session.close", sessionId: "nope" })).toEqual({
			ok: false,
			error: { code: "unknown_session", message: "No session nope." },
		});
	});

	it("waits for a start in progress before sending a request", async () => {
		const h = harness();
		const starting = h.host.start();
		const result = h.host.request({ command: "shutdown" });
		await starting;
		expect(await result).toEqual({ ok: true, result: {} });
	});

	it("forwards events and protocol errors", async () => {
		const h = harness();
		await h.host.start();
		const connection = h.connections[0] as FakeConnection;
		const event: AtelierEvent = { type: "text_delta", text: "hi", seq: 1, turnId: "t1" };
		connection.emitEvent("s1", event);
		connection.emitProtocolError("Unreadable line from the core: x");
		expect(h.sent.slice(1)).toEqual([
			{ type: "event", sessionId: "s1", event },
			{ type: "protocol_error", message: "Unreadable line from the core: x" },
		]);
	});

	it("tells the UI when the core dies, with its stderr", async () => {
		const h = harness();
		await h.host.start();
		(h.connections[0] as FakeConnection).crash({ code: 3, signal: null, stderr: "boom" });
		expect(h.sent.at(-1)).toEqual({ type: "core_exited", message: "The core stopped (exit code 3).\nboom" });
		expect((await h.host.request({ command: "shutdown" })).ok).toBe(false);
	});

	it("restarts with a new core without reporting the old one as crashed", async () => {
		const h = harness();
		await h.host.start();
		await h.host.restart();
		expect(h.connections).toHaveLength(2);
		expect(h.connections[0]?.closed).toBe(true);
		expect(h.sent.map((m) => m.type)).toEqual(["core_ready", "core_ready"]);
		expect((await h.host.request({ command: "shutdown" })).ok).toBe(true);
		expect(h.connections[1]?.requests).toEqual([{ command: "shutdown" }]);
	});

	it("does not orphan a core when started twice", async () => {
		const h = harness();
		await h.host.start();
		await h.host.start();
		await h.host.stop();
		expect(h.connections).toHaveLength(1);
		expect(h.connections.every((c) => c.closed)).toBe(true);
	});

	it("serializes overlapping restarts", async () => {
		const h = harness();
		await h.host.start();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const old = h.connections[0] as FakeConnection;
		old.close = async () => {
			await gate;
			old.closed = true;
		};
		const first = h.host.restart();
		const second = h.host.restart();
		release();
		await Promise.all([first, second]);
		await h.host.stop();
		expect(h.connections.every((c) => c.closed)).toBe(true);
	});

	it("lets stop win against an in-flight restart", async () => {
		const h = harness();
		await h.host.start();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const old = h.connections[0] as FakeConnection;
		old.close = async () => {
			await gate;
			old.closed = true;
		};
		const restarting = h.host.restart();
		const stopping = h.host.stop();
		release();
		await Promise.all([restarting, stopping]);
		expect(h.connections.every((c) => c.closed)).toBe(true);
		await h.host.start();
		expect(h.connections.every((c) => c.closed)).toBe(true);
	});

	it("remembers the core status for a renderer that subscribes late", async () => {
		const h = harness();
		expect(h.host.status()).toBeUndefined();
		await h.host.start();
		expect(h.host.status()).toEqual({ type: "core_ready", version: "9.9.9" });
		(h.connections[0] as FakeConnection).crash({ code: 1, signal: null, stderr: "" });
		expect(h.host.status()).toEqual({ type: "core_exited", message: "The core stopped (exit code 1)." });

		const failing = harness(async () => {
			throw new Error("no node");
		});
		await failing.host.start();
		expect(failing.host.status()).toEqual({ type: "core_failed", message: "no node" });
	});

	it("closes the core on stop without reporting a crash", async () => {
		const h = harness();
		await h.host.start();
		await h.host.stop();
		expect(h.connections[0]?.closed).toBe(true);
		expect(h.sent.map((m) => m.type)).toEqual(["core_ready"]);
	});
});
