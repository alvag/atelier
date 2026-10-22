import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodeServerMessage, LineSplitter, type ServerMessage } from "../src/index.ts";

const MAIN = fileURLToPath(new URL("../src/server/main.ts", import.meta.url));

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-serve-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

/** Runs `atelier-core serve` with the echo backend and feeds it command lines. */
function serve(args: string[] = ["serve"]) {
	const child = spawn(process.execPath, [MAIN, ...args], {
		env: { ...process.env, ATELIER_BACKEND: "echo" },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const messages: ServerMessage[] = [];
	const rawLines: string[] = [];
	let stderr = "";
	const splitter = new LineSplitter();
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
		for (const line of splitter.push(chunk)) {
			rawLines.push(line);
			messages.push(decodeServerMessage(line) as ServerMessage);
		}
	});
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk;
	});
	const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
	let next = 0;
	const send = (command: Record<string, unknown>) => {
		const id = `c${++next}`;
		child.stdin.write(`${JSON.stringify({ type: "command", id, ...command })}\n`);
		return id;
	};
	const waitFor = async (predicate: (m: ServerMessage) => boolean) => {
		for (let i = 0; i < 400; i++) {
			const found = messages.find(predicate);
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error(`Timed out. stdout: ${JSON.stringify(rawLines)} stderr: ${stderr}`);
	};
	return { child, messages, rawLines, stderr: () => stderr, exited, send, waitFor };
}

describe("atelier-core serve", () => {
	it("greets, runs a turn with the echo backend and exits 0 on shutdown", async () => {
		const s = serve();
		expect(await s.waitFor(() => true)).toEqual({ type: "hello", protocol: 2, core: "0.0.0" });

		const startId = s.send({ command: "session.start", cwd });
		const started = await s.waitFor((m) => m.type === "response" && m.id === startId);
		const sessionId = (started as unknown as { result: { sessionId: string } }).result.sessionId;

		s.send({ command: "session.send", sessionId, prompt: "hello" });
		await s.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		const text = s.messages.flatMap((m) => (m.type === "event" && m.event.type === "text_delta" ? [m.event.text] : []));
		expect(text.join("")).toBe("echo: hello");

		const shutdownId = s.send({ command: "shutdown" });
		await s.waitFor((m) => m.type === "response" && m.id === shutdownId);
		expect(await s.exited).toBe(0);
		for (const line of s.rawLines) expect(decodeServerMessage(line).type).not.toBe("unknown");
	});

	it("asks for approval over the protocol for bash", async () => {
		const s = serve();
		const startId = s.send({ command: "session.start", cwd });
		const started = await s.waitFor((m) => m.type === "response" && m.id === startId);
		const sessionId = (started as unknown as { result: { sessionId: string } }).result.sessionId;

		s.send({ command: "session.send", sessionId, prompt: "bash: echo approved-run" });
		const asked = await s.waitFor((m) => m.type === "event" && m.event.type === "approval_requested");
		const callId = (asked as { event: { callId: string } }).event.callId;
		s.send({ command: "session.approve", sessionId, callId, approved: true });
		const done = await s.waitFor((m) => m.type === "event" && m.event.type === "tool_call_finished");
		expect(done).toMatchObject({ event: { ok: true, summary: "echo approved-run (exit 0)" } });
		await s.waitFor((m) => m.type === "event" && m.event.type === "turn_finished");
		s.child.stdin.end();
		expect(await s.exited).toBe(0);
	});

	it("exits 0 when stdin closes", async () => {
		const s = serve();
		await s.waitFor(() => true);
		s.child.stdin.end();
		expect(await s.exited).toBe(0);
	});

	it("rejects unknown arguments with usage on stderr and exit code 2", async () => {
		const s = serve(["nope"]);
		expect(await s.exited).toBe(2);
		expect(s.stderr()).toContain("Usage: atelier-core serve");
		expect(s.rawLines).toEqual([]);
	});
});
