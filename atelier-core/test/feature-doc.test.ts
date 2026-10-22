import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	addTask,
	appendLog,
	createFeatureDoc,
	FeatureDocError,
	listTasks,
	parseFeatureDoc,
	parseSpecRefs,
	serializeFeatureDoc,
	updateTask,
} from "../src/odd/feature-doc.ts";

const fixtures = new URL("./fixtures/odd/", import.meta.url);
const fixture = (name: string) => readFile(new URL(name, fixtures), "utf8");

describe("parseFeatureDoc on the real documents of M0–M4", () => {
	it("round-trips every one byte for byte", async () => {
		const names = (await readdir(fixtures)).filter((name) => name.endsWith(".md")).sort();
		expect(names).toEqual([
			"m0-estudio.md",
			"m1-nucleo.md",
			"m2-protocolo.md",
			"m3-backend-propio.md",
			"m4-subagentes.md",
		]);
		for (const name of names) {
			const text = await fixture(name);
			expect(serializeFeatureDoc(parseFeatureDoc(text)), name).toBe(text);
		}
	});

	it("reads title, specs, tasks, log and keeps extra sections", async () => {
		const doc = parseFeatureDoc(await fixture("m4-subagentes.md"));
		expect(doc.title).toBe("M4 – Subagentes");
		expect(doc.specs.map((s) => s.id)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
		expect(doc.specs[0]?.text.startsWith('Pedido del usuario, textual: "si, van los 6"')).toBe(true);
		expect(listTasks(doc).map((t) => [t.id, t.specs, t.route])).toEqual([
			["U1", ["S1", "S3"], "inline"],
			["U2", ["S4"], "inline"],
			["U3", ["S5"], "inline"],
			["U4", ["S2", "S6"], "inline"],
		]);
		expect(doc.log[0]).toEqual({
			id: "L1",
			text: '"si, van los 6" (respuesta a "¿Van las seis, o querés cambiar alguna?").',
		});
		expect(doc.sections.map((s) => s.heading)).toEqual(["Specs", "Tasks", "Cortes de entrega", "Log"]);
	});

	it("keeps what follows the task table", async () => {
		const doc = parseFeatureDoc(await fixture("m0-estudio.md"));
		expect(doc.tasks.trailer.startsWith("### Preguntas por tarea")).toBe(true);
		expect(listTasks(doc).find((t) => t.id === "T7")?.specs).toEqual(["S1", "S2", "S3", "S4", "S5", "S6", "S8"]);
	});
});

describe("parseFeatureDoc errors", () => {
	const base =
		"# T\n\n## Specs\n\n- **S1** — a\n\n## Tasks\n\n| ID | Specs |\n|---|---|\n| T1 | S1 |\n\n## Log\n\n- **L1** — x\n";

	it("accepts a minimal document", () => {
		expect(serializeFeatureDoc(parseFeatureDoc(base))).toBe(base);
	});

	it.each([
		["a missing title", base.replace("# T\n\n", ""), /title/i],
		["a missing section", base.replace("## Log\n\n- **L1** — x\n", ""), /## Log/],
		["a stray line in Specs", base.replace("- **S1** — a", "- **S1** — a\nfree text"), /line 6.*Specs/],
		["a repeated spec id", base.replace("- **S1** — a", "- **S1** — a\n- **S1** — b"), /S1.*twice/],
		["a row with the wrong cell count", base.replace("| T1 | S1 |", "| T1 | S1 | extra |"), /line 11.*3 cells.*2/],
		["a repeated task id", base.replace("| T1 | S1 |", "| T1 | S1 |\n| T1 | S1 |"), /T1.*twice/],
	])("explains %s", (_name, text, reason) => {
		expect(() => parseFeatureDoc(text)).toThrow(FeatureDocError);
		expect(() => parseFeatureDoc(text)).toThrow(reason);
	});
});

describe("building and changing a document", () => {
	const created = () =>
		createFeatureDoc({
			title: "Slug improvements",
			header: "Make slugs safer.",
			specs: ['User, verbatim: "make slugify handle accents"', "Keep the existing tests green."],
			tasks: [
				{ title: "Transliterate accents", specs: ["S1"], route: "inline" },
				{ title: "Run the tests", specs: ["S2"], route: "inline" },
			],
		});

	it("writes the canonical format", () => {
		expect(serializeFeatureDoc(created())).toBe(
			[
				"# Slug improvements",
				"",
				"Make slugs safer.",
				"",
				"## Specs",
				"",
				'- **S1** — User, verbatim: "make slugify handle accents"',
				"- **S2** — Keep the existing tests green.",
				"",
				"## Tasks",
				"",
				"| ID | Specs | Ruta | Entregable | Estado |",
				"|---|---|---|---|---|",
				"| T1 | S1 | inline | Transliterate accents | pending |",
				"| T2 | S2 | inline | Run the tests | pending |",
				"",
				"## Log",
				"",
				"",
			].join("\n"),
		);
	});

	it("adds tasks, updates them and appends to the log, and the result parses back", () => {
		const doc = created();
		addTask(doc, { title: "Document | the change", specs: ["S1", "S2"], route: "worker" });
		updateTask(doc, { id: "T1", status: "done", commit: "abc1234" });
		updateTask(doc, { id: "T2", status: "blocked", note: "waiting for the user" });
		appendLog(doc, "user", 'make slugify handle accents\nand "quotes"');
		appendLog(doc, "agent", "T1 committed.");
		const again = parseFeatureDoc(serializeFeatureDoc(doc));
		expect(listTasks(again).map((t) => [t.id, t.title, t.status, t.specs])).toEqual([
			["T1", "Transliterate accents", "done", ["S1"]],
			["T2", "Run the tests", "blocked", ["S2"]],
			["T3", "Document | the change", "pending", ["S1", "S2"]],
		]);
		expect(listTasks(again)[0]?.commit).toBe("abc1234");
		expect(again.log).toEqual([
			{ id: "L1", text: 'Usuario: "make slugify handle accents\nand "quotes""' },
			{ id: "L2", text: "Agente: T1 committed." },
		]);
	});

	it("keeps user text verbatim even when it looks like document structure", () => {
		const doc = created();
		const tricky = 'hi\n## Tasks\n- **L5** — fake entry\n| T9 | S1 |\n\n  indented "end"\n';
		appendLog(doc, "user", tricky);
		const again = parseFeatureDoc(serializeFeatureDoc(doc));
		expect(again.log).toEqual([{ id: "L1", text: `Usuario: "${tricky}"` }]);
		expect(listTasks(again).map((t) => t.id)).toEqual(["T1", "T2"]);
	});

	it.each([
		["an unknown task", { id: "T9", status: "done" }, /T9/],
		["an invalid status", { id: "T1", status: "finished" }, /status/],
		["blocked without a note", { id: "T1", status: "blocked" }, /note/],
	])("rejects %s and leaves the document unchanged", (_name, update, reason) => {
		const doc = created();
		const before = serializeFeatureDoc(doc);
		expect(() => updateTask(doc, update as never)).toThrow(reason);
		expect(serializeFeatureDoc(doc)).toBe(before);
	});

	it("rejects tasks that cite specs that do not exist", () => {
		const doc = created();
		expect(() => addTask(doc, { title: "x", specs: ["S7"], route: "inline" })).toThrow(/S7/);
		expect(() =>
			createFeatureDoc({
				title: "x",
				header: "",
				specs: ["a"],
				tasks: [{ title: "y", specs: ["S2"], route: "inline" }],
			}),
		).toThrow(/S2/);
	});

	it("refuses to change the status of a document without an Estado column", async () => {
		const doc = parseFeatureDoc(await fixture("m4-subagentes.md"));
		expect(() => updateTask(doc, { id: "U1", status: "done" })).toThrow(/Estado/);
	});
});

describe("parseSpecRefs", () => {
	it("expands lists and ranges written with a dash or an en dash", () => {
		expect(parseSpecRefs("S1–S3, S8")).toEqual(["S1", "S2", "S3", "S8"]);
		expect(parseSpecRefs("S2-S4")).toEqual(["S2", "S3", "S4"]);
		expect(parseSpecRefs("—")).toEqual([]);
	});
});
