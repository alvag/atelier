import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectEngram, EngramMemory, parseObservationText } from "../src/memory/engram.ts";
import { FakeMemory, MemoryError, MemoryUnavailableError, MemoryUncertainError } from "../src/memory/port.ts";

const engramInstalled = (() => {
	try {
		execFileSync("engram", ["version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

describe("parseObservationText", () => {
	it("splits header, content and the trailing metadata, even when the content looks like metadata", () => {
		const text = [
			"#7 [decision] Use MCP for Engram",
			"**What**: chose MCP",
			"Session: this line is content",
			"**Why**: generic contract",
			"Session: manual-save-proj",
			"Project: proj",
			"Scope: project",
			"Topic: atelier/engram-transport",
			"Duplicates: 1",
			"Revisions: 2",
			"Created: 2026-10-22 17:15:21",
		].join("\n");
		expect(parseObservationText(text)).toEqual({
			id: 7,
			type: "decision",
			title: "Use MCP for Engram",
			content: "**What**: chose MCP\nSession: this line is content\n**Why**: generic contract",
			topicKey: "atelier/engram-transport",
		});
	});

	it("keeps content that ends with metadata-like lines: only Engram's block, from its Session line down, is metadata", () => {
		const text = [
			"#3 [decision] Tail",
			"body",
			"Project: looks like metadata",
			"Session: also looks like metadata",
			"Session: manual-save-proj",
			"Project: proj",
			"Scope: project",
			"Duplicates: 1",
			"Revisions: 1",
			"Created: 2026-10-22 17:15:21",
		].join("\n");
		expect(parseObservationText(text)?.content).toBe(
			"body\nProject: looks like metadata\nSession: also looks like metadata",
		);
	});

	it("refuses a metadata block without its Session line instead of cutting content", () => {
		expect(parseObservationText("#3 [decision] Tail\nbody\nProject: proj\nCreated: 2026-10-22")).toBeUndefined();
	});

	it("returns undefined for text it does not recognize", () => {
		expect(parseObservationText("something else")).toBeUndefined();
	});
});

describe("FakeMemory", () => {
	it("saves, upserts by topic key, searches and gets", async () => {
		const memory = new FakeMemory("proj");
		const first = await memory.save({ title: "A", type: "decision", content: "alpha", topicKey: "t/a" });
		const again = await memory.save({ title: "A2", type: "decision", content: "alpha two", topicKey: "t/a" });
		await memory.save({ title: "B", type: "bugfix", content: "beta" });
		expect(again.id).toBe(first.id);
		expect(await memory.search("alpha", 10)).toEqual([
			{ id: first.id, title: "A2", type: "decision", preview: "alpha two" },
		]);
		expect(await memory.get(first.id)).toEqual({
			id: first.id,
			title: "A2",
			type: "decision",
			content: "alpha two",
			topicKey: "t/a",
		});
		expect(await memory.get(999)).toBeUndefined();
	});
});

/** An EngramMemory over an in-process MCP server whose tools answer `answer`; `calls` counts the calls. */
async function engramAnswering(answer: Record<string, unknown>, isError = false, savesPrompts = false) {
	const server = new Server({ name: "engram", version: "0.0.0" }, { capabilities: { tools: {} } });
	const calls: string[] = [];
	const args: Record<string, unknown>[] = [];
	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		calls.push(request.params.name);
		args.push(request.params.arguments ?? {});
		return { content: [{ type: "text", text: JSON.stringify(answer) }], isError };
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "atelier", version: "0.0.0" });
	await client.connect(clientSide);
	return { memory: new EngramMemory(client, "proj", { prompts: savesPrompts, sessions: true }), calls, args };
}

describe("EngramMemory session", () => {
	it("registers the session, names it in every write and ends it", async () => {
		const { memory, calls, args } = await engramAnswering({ id: 5 }, false, true);
		await memory.begin("atelier-1", "/work");
		await memory.save({ title: "A", type: "decision", content: "alpha" });
		await memory.savePrompt("fix it");
		await memory.summary("## Goal");
		await memory.end();
		await memory.close();
		expect(calls).toEqual([
			"mem_session_start",
			"mem_save",
			"mem_save_prompt",
			"mem_session_summary",
			"mem_session_end",
		]);
		expect(args[0]).toEqual({ id: "atelier-1", directory: "/work" });
		for (const written of args.slice(1, 4)) expect(written.session_id).toBe("atelier-1");
		expect(args[4]).toEqual({ id: "atelier-1" });
	});

	it("writes without a session when Engram refused it, and has nothing to end", async () => {
		const { memory, calls, args } = await engramAnswering({ error: "no" }, true, true);
		await expect(memory.begin("atelier-1", "/work")).rejects.toThrow(/mem_session_start/);
		await memory.savePrompt("fix it").catch(() => {});
		await memory.end();
		await memory.close();
		expect(calls).toEqual(["mem_session_start", "mem_save_prompt"]);
		expect(args[1]).toEqual({ content: "fix it" });
	});
});

describe("EngramMemory savePrompt", () => {
	it("sends the prompt as it is given, or nothing when prompts are off", async () => {
		const on = await engramAnswering({ id: 4 }, false, true);
		await on.memory.savePrompt("fix the parser");
		await on.memory.close();
		expect(on.calls).toEqual(["mem_save_prompt"]);
		expect(on.args).toEqual([{ content: "fix the parser" }]);

		const off = await engramAnswering({ id: 4 });
		await off.memory.savePrompt("fix the parser");
		await off.memory.close();
		expect(off.calls).toEqual([]);
	});
});

describe("EngramMemory save", () => {
	it("keeps a save whose conflict detection did not finish, with a warning, and does not save again", async () => {
		const { memory, calls } = await engramAnswering({ id: 12, candidate_detection_status: "incomplete" });
		const saved = await memory.save({ title: "A", type: "decision", content: "alpha" });
		await memory.close();
		expect(saved.id).toBe(12);
		expect(saved.warning).toMatch(/conflict/i);
		expect(calls).toEqual(["mem_save"]);
	});

	it("tells a refusal from a call that got no answer, which may have saved", async () => {
		const refused = await engramAnswering({ error: "refused" }, true);
		const error = await refused.memory.save({ title: "A", type: "decision", content: "alpha" }).catch((e) => e);
		await refused.memory.close();
		expect(error).toBeInstanceOf(MemoryError);
		expect(error).not.toBeInstanceOf(MemoryUncertainError);

		const gone = await engramAnswering({ id: 1 });
		await gone.memory.close();
		const lost = await gone.memory.save({ title: "A", type: "decision", content: "alpha" }).catch((e) => e);
		expect(lost).toBeInstanceOf(MemoryUncertainError);
	});

	it("has no warning when conflict detection finished or is not reported", async () => {
		for (const answer of [{ id: 3, candidate_detection_status: "complete" }, { id: 3 }]) {
			const { memory } = await engramAnswering(answer);
			expect(await memory.save({ title: "A", type: "decision", content: "alpha" })).toEqual({ id: 3 });
			await memory.close();
		}
	});
});

describe.skipIf(!engramInstalled)("EngramMemory against the real binary (temporary data dir)", () => {
	let root: string;
	let project: string;
	let memory: EngramMemory;
	let env: Record<string, string | undefined>;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "atelier-engram-"));
		project = join(root, "atelier-memory-proj");
		await mkdir(project);
		execFileSync("git", ["init", "-q"], { cwd: project });
		// ENGRAM_URL points nowhere: the adapter must drop it, and the data dir keeps the user's memory untouched.
		env = { ...process.env, ENGRAM_DATA_DIR: join(root, "data"), ENGRAM_URL: "http://127.0.0.1:9" };
		memory = await connectEngram({ cwd: project, env });
	}, 30_000);

	afterAll(async () => {
		await memory?.close();
		await rm(root, { recursive: true, force: true });
	});

	it("uses the project Engram detects from the session folder", () => {
		expect(memory.project).toBe(basename(project));
	});

	it("saves, finds with a preview, gets the exact content, and updates by topic key", async () => {
		const content = "**What**: chose MCP\nSession: this line is content\n**Why**: generic contract";
		const saved = await memory.save({ title: "Use MCP for Engram", type: "decision", content, topicKey: "atelier/x" });
		const hits = await memory.search("MCP", 5);
		expect(hits).toEqual([expect.objectContaining({ id: saved.id, title: "Use MCP for Engram", type: "decision" })]);
		expect(hits[0]?.preview).toContain("chose MCP");
		expect(await memory.get(saved.id)).toEqual({
			id: saved.id,
			title: "Use MCP for Engram",
			type: "decision",
			content,
			topicKey: "atelier/x",
		});
		const updated = await memory.save({
			title: "Use MCP for Engram",
			type: "decision",
			content: "v2",
			topicKey: "atelier/x",
		});
		expect(updated.id).toBe(saved.id);
		expect((await memory.get(saved.id))?.content).toBe("v2");
	});

	it("gets back content whose last line looks like Engram metadata", async () => {
		const content = "**What**: tail case\nSession: this is content";
		const saved = await memory.save({ title: "Tail case", type: "discovery", content });
		expect((await memory.get(saved.id))?.content).toBe(content);
	});

	it("returns undefined for a missing entry", async () => {
		expect(await memory.get(987_654)).toBeUndefined();
	});

	it("gives a bounded context and saves a session summary", async () => {
		const context = await memory.context(300);
		expect(Buffer.byteLength(context)).toBeLessThanOrEqual(300);
		expect(context).toContain("Use MCP for Engram");
		await expect(memory.summary("## Goal\nTest the adapter")).resolves.toBeUndefined();
	});

	it("saves a prompt", async () => {
		await expect(memory.savePrompt("remember the parser")).resolves.toBeUndefined();
	});

	it("registers a session, saves under it and ends it", async () => {
		await memory.begin("atelier-test-session", project);
		await memory.savePrompt("inside the session");
		await memory.save({ title: "In session", type: "discovery", content: "**What**: saved under the session" });
		await expect(memory.end()).resolves.toBeUndefined();
	});

	it("never wrote outside the temporary data dir", async () => {
		expect(await readdir(join(root, "data"))).toContain("engram.db");
	});

	it("refuses an Engram older than the minimum, with the reason", async () => {
		const fake = join(root, "old-engram");
		await writeFile(fake, '#!/bin/sh\necho "engram 3.3.9"\n');
		await chmod(fake, 0o755);
		const error = await connectEngram({ cwd: project, env, command: fake }).catch((e) => e);
		expect(error).toBeInstanceOf(MemoryUnavailableError);
		expect(error.message).toMatch(/3\.3\.9.*3\.4\.0/);
	});
});

describe("connectEngram without the binary", () => {
	it("says Engram is not installed", async () => {
		const error = await connectEngram({ cwd: tmpdir(), env: {}, command: "/nonexistent/engram" }).catch((e) => e);
		expect(error).toBeInstanceOf(MemoryUnavailableError);
		expect(error.message).toMatch(/not installed/);
	});
});

describe("memory boundary", () => {
	it("keeps Engram inside its adapter: nothing else in the code mentions it", async () => {
		const offenders: string[] = [];
		const workspace = new URL("../../", import.meta.url).pathname;
		const walk = async (dir: string): Promise<void> => {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) await walk(path);
				else if (/\.(ts|tsx)$/.test(entry.name) && /engram/i.test(await readFile(path, "utf8")))
					offenders.push(relative(workspace, path));
			}
		};
		for (const src of ["atelier-core/src", "atelier-cli/src", "atelier-desktop/src"]) await walk(join(workspace, src));
		expect(offenders.sort()).toEqual(["atelier-core/src/memory/engram.ts", "atelier-core/src/memory/index.ts"]);
		// The module's index names the adapter only to re-export it under neutral names.
		const index = await readFile(join(workspace, "atelier-core/src/memory/index.ts"), "utf8");
		expect(index.split("\n").filter((line) => /engram/i.test(line))).toEqual([
			'export { connectEngram as connectMemory, ENGRAM_MIN_VERSION as MEMORY_MIN_VERSION } from "./engram.ts";',
		]);
	});
});

it("classifies a definite protocol rejection as failed, not uncertain (S1)", async () => {
	const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
	const client = {
		callTool: async () => {
			throw new McpError(ErrorCode.InvalidParams, "Invalid params");
		},
	} as unknown as Client;
	const memory = new EngramMemory(client, "proj");
	const error = await memory.save({ title: "A", type: "decision", content: "x" }).catch((e) => e);
	expect(error).toBeInstanceOf(MemoryError);
	expect(error).not.toBeInstanceOf(MemoryUncertainError);
});

it("classifies a timeout, a closed connection or an internal error as uncertain: the call may have landed", async () => {
	const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
	for (const code of [ErrorCode.RequestTimeout, ErrorCode.ConnectionClosed, ErrorCode.InternalError]) {
		const client = {
			callTool: async () => {
				throw new McpError(code, "lost");
			},
		} as unknown as Client;
		const error = await new EngramMemory(client, "proj")
			.save({ title: "A", type: "decision", content: "x" })
			.catch((e) => e);
		expect(error).toBeInstanceOf(MemoryUncertainError);
	}
});

it("gives a prompt save 5 s and every other call 15 s, so a hung Engram holds a turn's end 5 s at most", async () => {
	const timeouts: Record<string, number | undefined> = {};
	const client = {
		callTool: async (request: { name: string }, _schema: unknown, options?: { timeout?: number }) => {
			timeouts[request.name] = options?.timeout;
			return { content: [{ type: "text", text: JSON.stringify({ id: 1 }) }] };
		},
	} as unknown as Client;
	const memory = new EngramMemory(client, "proj", { prompts: true });
	await memory.savePrompt("fix it");
	await memory.save({ title: "A", type: "decision", content: "x" });
	expect(timeouts).toEqual({ mem_save_prompt: 5_000, mem_save: 15_000 });
});
