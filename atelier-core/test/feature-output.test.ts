import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AtelierEvent, FakeBackend, type FakeStep, listTasks, parseFeatureDoc, Session } from "../src/index.ts";
import { grepTool } from "../src/tools/grep.ts";
import { MAX_BYTES, MAX_LINES } from "../src/tools/limits.ts";
import { readTool } from "../src/tools/read.ts";

const path = "odd/tasks/output.md";
const notice = `[Output truncated. Use grep on "${path}" to find a task ID or section heading, then read that file with offset and limit. For an oversized single line, use bash byte ranges. Do not repeat a mutation to retrieve its output.]`;
const start = {
	action: "start",
	name: "output",
	title: "Feature output",
	specs: ["Handle accents."],
	tasks: [{ title: "Transliterate accents", specs: ["S1"], route: "inline" }],
};

let cwd: string;
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "atelier-feature-output-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

async function run(inputs: Record<string, unknown>[]) {
	const steps: FakeStep[] = inputs.map((input, i) => ({
		toolCall: { tool: "feature", input: input as never, callId: `f${i}` },
	}));
	steps.push({
		event: {
			type: "turn_finished",
			stopReason: "end_turn",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		},
	});
	const backend = new FakeBackend([steps]);
	const session = await Session.start({ backend, cwd, tools: [], odd: true });
	const events: AtelierEvent[] = [];
	try {
		for await (const event of session.send("Track this work.")) events.push(event);
	} finally {
		await session.close();
	}
	return {
		results: backend.toolResults,
		finished: events.filter((event) => event.type === "tool_call_finished"),
		changed: events.filter((event) => event.type === "feature_changed"),
	};
}

function bounded(output: string) {
	expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_BYTES);
	expect(output.split("\n").length).toBeLessThanOrEqual(MAX_LINES);
	expect(output).not.toContain("\ufffd");
	expect(output.split(notice)).toHaveLength(2);
}

async function largeTaskFile() {
	await mkdir(join(cwd, "odd/tasks"), { recursive: true });
	await writeFile(
		join(cwd, path),
		[
			"# Feature output\n\n## Specs\n\n- **S1** — Handle accents.\n\n## Tasks\n",
			"| ID | Specs | Ruta | Entregable | Estado |",
			"|---|---|---|---|---|",
			...Array.from({ length: 2200 }, (_, i) => `| T${i + 1} | S1 | inline | Step ${i + 1} | pending |`),
			"\n## Log\n",
		].join("\n"),
	);
}

describe("feature model-facing output", () => {
	it("keeps a small result exactly as before, without a truncation flag", async () => {
		const { results, finished } = await run([start, { action: "show" }]);
		const output = [
			`Feature output — ${path}`,
			"Specs:",
			"S1 — Handle accents.",
			"Tasks:",
			"T1 [pending] Transliterate accents (S1)",
			"Log: 1 entries.",
		].join("\n");
		expect(results.map((result) => result.output)).toEqual([`Started ${path}.\n${output}`, output]);
		expect(finished.map((event) => event.truncated)).toEqual([false, false]);
	});

	it.each([MAX_LINES, MAX_LINES + 1])("bounds a %i-line result including the notice", async (count) => {
		const lines = Array.from({ length: count - 4 }, (_, i) => `spec line ${i}`);
		const { results, finished } = await run([{ ...start, tasks: [], specs: [lines.join("\n")] }, { action: "show" }]);
		const output = results[1]?.output ?? "";
		expect(finished[1]?.truncated).toBe(count > MAX_LINES);
		expect(output).toContain(lines[0]);
		expect(output).toContain(lines.at(-1));
		expect(output.endsWith("Log: 1 entries.")).toBe(true);
		if (count > MAX_LINES) {
			bounded(output);
			expect(output).not.toContain("spec line 999\n");
		} else {
			expect(output.split("\n")).toHaveLength(MAX_LINES);
			expect(output).not.toContain(notice);
		}
	});

	it.each([MAX_BYTES, MAX_BYTES + 1])("bounds a %i-byte result including the notice", async (bytes) => {
		const base = `Feature output — ${path}\nSpecs:\nS1 — \nTasks:\nLog: 1 entries.`;
		const spec = "x".repeat(bytes - Buffer.byteLength(base));
		const { results, finished } = await run([{ ...start, tasks: [], specs: [spec] }, { action: "show" }]);
		const output = results[1]?.output ?? "";
		expect(finished[1]?.truncated).toBe(bytes > MAX_BYTES);
		if (bytes > MAX_BYTES) bounded(output);
		else expect(Buffer.byteLength(output)).toBe(MAX_BYTES);
	});

	it("keeps both ends of an oversized Unicode line without splitting UTF-8", async () => {
		const spec = `BEGIN ${"🧪é".repeat(20000)} END`;
		const { results, finished } = await run([{ ...start, specs: [spec] }, { action: "show" }]);
		for (const result of results) {
			bounded(result.output);
			expect(result.output).toContain("S1 — BEGIN 🧪é");
			expect(result.output).toContain("🧪é END\nTasks:");
			expect(result.output.endsWith("Log: 1 entries.")).toBe(true);
		}
		expect(finished.every((event) => event.truncated)).toBe(true);
		expect(parseFeatureDoc(await readFile(join(cwd, path), "utf8")).specs[0]?.text).toBe(spec);
	});

	it("bounds open, show and every mutation without losing tasks, events or log entries", async () => {
		await largeTaskFile();
		const { results, finished, changed } = await run([
			{ action: "open", name: "output" },
			{ action: "show" },
			{ action: "add_task", task: { title: "Last step", specs: ["S1"], route: "inline" } },
			{ action: "update_task", id: "T1100", status: "in_progress" },
			{ action: "log", text: "One agent entry." },
		]);
		for (const result of results) {
			expect(result.ok).toBe(true);
			bounded(result.output);
			expect(result.output).toContain("T1 [pending] Step 1 (S1)");
			expect(result.output).toContain("T2200 [pending] Step 2200 (S1)");
			expect(result.output).not.toContain("T1100 [");
		}
		expect(finished.every((event) => event.truncated)).toBe(true);
		expect(changed.map((event) => event.tasks.length)).toEqual([2200, 2201, 2201, 2201]);
		expect(changed.at(-1)?.tasks[1099]).toMatchObject({ id: "T1100", status: "in_progress" });
		const before = await readFile(join(cwd, path), "utf8");
		const doc = parseFeatureDoc(before);
		expect(listTasks(doc)).toHaveLength(2201);
		expect(doc.log.map((entry) => entry.text)).toEqual(['Usuario: "Track this work."', "Agente: One agent entry."]);

		// Follow the notice through public read tools rather than repeating a mutation.
		const match = await grepTool.execute({ path, pattern: "| T1100 |", literal: true }, { cwd });
		expect(match.ok).toBe(true);
		const line = Number(/:(\d+):/.exec(match.output)?.[1]);
		expect(line).toBeGreaterThan(0);
		const page = await readTool.execute({ path, offset: line, limit: 1 }, { cwd });
		expect(page.ok).toBe(true);
		expect(page.output).toContain("| T1100 | S1 | inline | Step 1100 | in_progress |");
		const section = await grepTool.execute({ path, pattern: "## Specs", literal: true }, { cwd });
		expect(section.output).toContain("## Specs");
		expect(await readFile(join(cwd, path), "utf8")).toBe(before);
	});

	it("caps a huge title's client summary at 500 Unicode characters", async () => {
		const title = "🧪".repeat(30000);
		const { results, finished } = await run([{ ...start, title }, { action: "show" }]);
		for (const result of results) bounded(result.output);
		for (const event of finished) {
			expect(Array.from(event.summary).length).toBeLessThanOrEqual(500);
			expect(event.summary).not.toContain("\ufffd");
		}
		expect(parseFeatureDoc(await readFile(join(cwd, path), "utf8")).title).toBe(title);
	});
});
