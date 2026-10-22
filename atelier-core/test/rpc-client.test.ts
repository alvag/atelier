import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AtelierEvent, RpcClient, RpcError } from "../src/index.ts";

const MAIN = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));
const echoCore = { command: process.execPath, args: [MAIN, "serve"], env: { ...process.env, ATELIER_BACKEND: "echo" } };

/** A stand-in core written inline, for failure cases the real core never produces. */
function scriptCore(source: string) {
	return { command: process.execPath, args: ["-e", source] };
}

let cwd: string;
let clients: RpcClient[] = [];
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-client-"));
	clients = [];
});
afterEach(async () => {
	await Promise.all(clients.map((client) => client.close()));
	await rm(cwd, { recursive: true, force: true });
});

async function connect(options: Parameters<typeof RpcClient.connect>[0]) {
	const client = await RpcClient.connect(options);
	clients.push(client);
	return client;
}

describe("RpcClient", () => {
	it("connects, runs a turn and receives its events", async () => {
		const client = await connect(echoCore);
		expect(client.coreVersion).toBe("0.0.0");
		const events: AtelierEvent[] = [];
		const finished = new Promise<void>((resolve) => {
			client.onEvent((sessionId, event) => {
				events.push(event);
				if (event.type === "turn_finished") resolve();
				expect(typeof sessionId).toBe("string");
			});
		});

		const { sessionId } = await client.request({ command: "session.start", cwd });
		const { turnId } = await client.request({ command: "session.send", sessionId, prompt: "hi" });
		await finished;
		expect(events.every((e) => e.turnId === turnId)).toBe(true);
		expect(events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("")).toBe("echo: hi");
	});

	it("rejects a failed command with its code", async () => {
		const client = await connect(echoCore);
		const failure = client.request({ command: "session.close", sessionId: "nope" });
		await expect(failure).rejects.toBeInstanceOf(RpcError);
		await expect(failure).rejects.toMatchObject({ code: "unknown_session", message: "No session nope." });
	});

	it("rejects pending commands with core_exited when the core dies, with its stderr", async () => {
		const client = await connect(
			scriptCore(`
				process.stdout.write(JSON.stringify({ type: "hello", protocol: 1, core: "test" }) + "\\n");
				process.stdin.once("data", () => { process.stderr.write("boom: out of memory\\n"); process.exit(3); });
			`),
		);
		const exited = new Promise<{ code: number | null }>((resolve) => client.onExit(resolve));
		const pending = client.request({ command: "session.start", cwd });
		await expect(pending).rejects.toMatchObject({ code: "core_exited" });
		await expect(pending).rejects.toThrow(/exit code 3.*boom: out of memory/s);
		expect(await exited).toMatchObject({ code: 3 });
		await expect(client.request({ command: "shutdown" })).rejects.toMatchObject({ code: "core_exited" });
	});

	it("refuses a core that speaks another protocol version", async () => {
		await expect(
			RpcClient.connect(
				scriptCore(
					`process.stdout.write(JSON.stringify({ type: "hello", protocol: 99, core: "future" }) + "\\n"); setInterval(() => {}, 1000);`,
				),
			),
		).rejects.toMatchObject({ code: "protocol_mismatch" });
	});

	it("fails to connect when the core never says hello", async () => {
		await expect(
			RpcClient.connect({ ...scriptCore("setInterval(() => {}, 1000);"), helloTimeoutMs: 200 }),
		).rejects.toMatchObject({ code: "hello_timeout" });
	});

	it("fails to connect when the core cannot start", async () => {
		await expect(RpcClient.connect({ command: join(cwd, "no-such-binary"), args: [] })).rejects.toMatchObject({
			code: "core_exited",
		});
	});

	it("reports protocol errors from the core", async () => {
		const client = await connect(
			scriptCore(`
				process.stdout.write(JSON.stringify({ type: "hello", protocol: 1, core: "test" }) + "\\n");
				process.stdout.write("garbage line\\n");
				process.stdout.write(JSON.stringify({ type: "protocol_error", message: "Invalid JSON." }) + "\\n");
				setInterval(() => {}, 1000);
			`),
		);
		const problems: string[] = [];
		client.onProtocolError((message) => problems.push(message));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(problems).toEqual(["Unreadable line from the core: garbage line", "Invalid JSON."]);
	});

	it("closes with shutdown and the core exits 0", async () => {
		const client = await RpcClient.connect(echoCore);
		const exited = new Promise<{ code: number | null }>((resolve) => client.onExit(resolve));
		await client.close();
		expect(await exited).toMatchObject({ code: 0 });
	});

	it("kills a core that ignores shutdown", async () => {
		const client = await RpcClient.connect({
			...scriptCore(`
				process.stdout.write(JSON.stringify({ type: "hello", protocol: 1, core: "test" }) + "\\n");
				process.stdin.on("data", () => {});
				process.on("SIGTERM", () => {});
				setInterval(() => {}, 1000);
			`),
			closeTimeoutMs: 200,
		});
		const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => client.onExit(resolve));
		const started = Date.now();
		await client.close();
		expect(Date.now() - started).toBeLessThan(3000);
		expect((await exited).signal).toBe("SIGKILL");
	});
});
