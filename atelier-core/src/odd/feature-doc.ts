/**
 * The ODD feature document (`odd/tasks/<feature>.md`): title, a short header,
 * `## Specs` (S#), `## Tasks` (a table) and `## Log` (L#), plus any other
 * section kept as written. Parsing is lenient (documents written by hand
 * round-trip byte for byte); changes are strict, so the model cannot leave the
 * document malformed.
 */

export const TASK_STATUSES = ["pending", "in_progress", "blocked", "done", "dropped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Columns of a document Atelier creates; Estado holds the status. */
export const CANONICAL_COLUMNS = ["ID", "Specs", "Ruta", "Entregable", "Estado"] as const;

export interface Item {
	id: string;
	/** May span several lines. */
	text: string;
}

export interface TaskTable {
	columns: string[];
	/** Cells as written, with `|` escaped. */
	rows: string[][];
	/** Whatever follows the table in the Tasks section, kept as written. */
	trailer: string;
}

export interface Section {
	heading: string;
	/** Body as written; for Specs, Tasks and Log it is rebuilt from the parsed parts. */
	body: string;
}

export interface FeatureDoc {
	title: string;
	header: string;
	sections: Section[];
	specs: Item[];
	tasks: TaskTable;
	log: Item[];
}

export interface TaskView {
	id: string;
	title: string;
	specs: string[];
	route: string;
	status?: TaskStatus;
	commit?: string;
	note?: string;
}

export class FeatureDocError extends Error {
	override name = "FeatureDocError";
}

const ITEM = /^- \*\*([SL]\d+)\*\* — (.*)$/;
const SEPARATOR = /^\|(\s*:?-+:?\s*\|)+$/;

export function parseFeatureDoc(text: string): FeatureDoc {
	const lines = (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
	const first = lines[0] ?? "";
	if (!first.startsWith("# ") || first.slice(2).trim() === "")
		throw new FeatureDocError("line 1: expected the title, '# <title>'.");
	const title = first.slice(2);

	const headings = lines.flatMap((line, index) => (line.startsWith("## ") ? [index] : []));
	const header = trimBlank(lines.slice(1, headings[0] ?? lines.length)).join("\n");
	const sections: Section[] = [];
	const bodyStart: number[] = [];
	headings.forEach((start, n) => {
		const end = headings[n + 1] ?? lines.length;
		const raw = lines.slice(start + 1, end);
		const leading = raw.findIndex((line) => line.trim() !== "");
		bodyStart.push(start + 2 + (leading === -1 ? 0 : leading));
		sections.push({ heading: (lines[start] as string).slice(3), body: trimBlank(raw).join("\n") });
	});

	const find = (heading: string) => {
		const index = sections.findIndex((section) => section.heading === heading);
		if (index === -1) throw new FeatureDocError(`missing the '## ${heading}' section.`);
		if (sections.findIndex((section, i) => i > index && section.heading === heading) !== -1)
			throw new FeatureDocError(`the '## ${heading}' section appears twice.`);
		return { body: (sections[index] as Section).body, line: bodyStart[index] as number };
	};

	const specs = find("Specs");
	const tasks = find("Tasks");
	const log = find("Log");
	return {
		title,
		header,
		sections,
		specs: parseItems(specs.body, specs.line, "S", "Specs"),
		tasks: parseTable(tasks.body, tasks.line),
		log: parseItems(log.body, log.line, "L", "Log"),
	};
}

export function serializeFeatureDoc(doc: FeatureDoc): string {
	const body = (section: Section) => {
		if (section.heading === "Specs") return doc.specs.map(itemLine).join("\n");
		if (section.heading === "Log") return doc.log.map(itemLine).join("\n");
		if (section.heading === "Tasks") return tableText(doc.tasks);
		return section.body;
	};
	const parts = [`# ${doc.title}\n\n`, doc.header === "" ? "" : `${doc.header}\n\n`];
	parts.push(
		doc.sections
			.map((section) => {
				const text = body(section);
				return text === "" ? `## ${section.heading}\n\n` : `## ${section.heading}\n\n${text}\n`;
			})
			.join("\n"),
	);
	return parts.join("");
}

export interface NewTask {
	title: string;
	specs: string[];
	route: string;
}

export function createFeatureDoc(input: {
	title: string;
	header: string;
	specs: string[];
	tasks: NewTask[];
}): FeatureDoc {
	const title = singleLine(input.title, "title");
	if (title === "") throw new FeatureDocError("the title is empty.");
	if (input.specs.length === 0) throw new FeatureDocError("a feature needs at least one spec.");
	const specs = input.specs.map((text, index) => {
		if (text.trim() === "") throw new FeatureDocError(`S${index + 1} is empty.`);
		return { id: `S${index + 1}`, text };
	});
	const doc: FeatureDoc = {
		title,
		header: input.header.trim(),
		sections: ["Specs", "Tasks", "Log"].map((heading) => ({ heading, body: "" })),
		specs,
		tasks: { columns: [...CANONICAL_COLUMNS], rows: [], trailer: "" },
		log: [],
	};
	for (const task of input.tasks) addTask(doc, task);
	return doc;
}

/** Adds T<next> as pending. Validates before changing anything. */
export function addTask(doc: FeatureDoc, task: NewTask): string {
	const columns = canonicalColumns(doc);
	const known = new Set(doc.specs.map((spec) => spec.id));
	const missing = task.specs.filter((id) => !known.has(id));
	if (missing.length > 0) throw new FeatureDocError(`the task cites ${missing.join(", ")}, which does not exist.`);
	const title = singleLine(task.title, "task title");
	if (title === "") throw new FeatureDocError("the task title is empty.");
	const numbers = listTasks(doc).flatMap((t) => (/^T\d+$/.test(t.id) ? [Number(t.id.slice(1))] : []));
	const id = `T${Math.max(0, ...numbers) + 1}`;
	const cells: Record<string, string> = {
		ID: id,
		Specs: task.specs.join(", ") || "—",
		Ruta: escapeCell(singleLine(task.route, "route") || "inline"),
		Entregable: escapeCell(title),
		Estado: "pending",
	};
	doc.tasks.rows.push(columns.map((column) => cells[column] ?? ""));
	return id;
}

export interface TaskUpdate {
	id: string;
	status: TaskStatus;
	note?: string;
	commit?: string;
}

/** Writes the Estado cell: `status`, then `` (`commit`) `` and ` — note` when given. */
export function updateTask(doc: FeatureDoc, update: TaskUpdate): void {
	const columns = canonicalColumns(doc);
	if (!(TASK_STATUSES as readonly string[]).includes(update.status))
		throw new FeatureDocError(`invalid status '${update.status}'; use ${TASK_STATUSES.join(", ")}.`);
	const note = update.note === undefined ? "" : singleLine(update.note, "note");
	if (update.status === "blocked" && note === "")
		throw new FeatureDocError("a blocked task needs a note saying what it waits for.");
	const row = doc.tasks.rows.find((cells) => cells[columns.indexOf("ID")] === update.id);
	if (!row) throw new FeatureDocError(`there is no task ${update.id}.`);
	const commit = update.commit === undefined ? "" : singleLine(update.commit, "commit").replaceAll("`", "");
	row[columns.indexOf("Estado")] = escapeCell(
		`${update.status}${commit === "" ? "" : ` (\`${commit}\`)`}${note === "" ? "" : ` — ${note}`}`,
	);
}

/** Appends L<next>. User text is quoted as is; only the code writes user entries. */
export function appendLog(doc: FeatureDoc, author: "user" | "agent", text: string): string {
	const id = `L${doc.log.length + 1}`;
	doc.log.push({ id, text: author === "user" ? `Usuario: "${text}"` : `Agente: ${text}` });
	return id;
}

export function listTasks(doc: FeatureDoc): TaskView[] {
	const at = (cells: string[], column: string) => {
		const index = doc.tasks.columns.indexOf(column);
		return index === -1 ? "" : unescapeCell(cells[index] ?? "");
	};
	return doc.tasks.rows.map((cells) => {
		const view: TaskView = {
			id: at(cells, "ID"),
			title: at(cells, "Entregable"),
			specs: parseSpecRefs(at(cells, "Specs")),
			route: at(cells, "Ruta"),
		};
		const estado = /^(\w+)(?: \(`([^`]*)`\))?(?: — (.*))?$/.exec(at(cells, "Estado"));
		if (estado && (TASK_STATUSES as readonly string[]).includes(estado[1] as string)) {
			view.status = estado[1] as TaskStatus;
			if (estado[2]) view.commit = estado[2];
			if (estado[3]) view.note = estado[3];
		}
		return view;
	});
}

/** "S1–S3, S8" → S1, S2, S3, S8. Ranges may use "-" or "–". */
export function parseSpecRefs(text: string): string[] {
	const ids: string[] = [];
	for (const part of text.split(",")) {
		const range = /^\s*S(\d+)\s*[-–]\s*S(\d+)\s*$/.exec(part);
		if (range) {
			for (let n = Number(range[1]); n <= Number(range[2]); n++) ids.push(`S${n}`);
			continue;
		}
		const single = /^\s*(S\d+)\s*$/.exec(part);
		if (single) ids.push(single[1] as string);
	}
	return ids;
}

function parseItems(body: string, firstLine: number, prefix: "S" | "L", section: string): Item[] {
	const items: Item[] = [];
	if (body === "") return items;
	body.split("\n").forEach((line, offset) => {
		const match = ITEM.exec(line);
		if (match && (match[1] as string).startsWith(prefix)) {
			const id = match[1] as string;
			if (items.some((item) => item.id === id)) throw new FeatureDocError(`${id} appears twice in ${section}.`);
			items.push({ id, text: match[2] as string });
			return;
		}
		const last = items.at(-1);
		if (last && line.startsWith("  ")) {
			last.text += `\n${line.slice(2)}`;
			return;
		}
		throw new FeatureDocError(
			`line ${firstLine + offset}: expected '- **${prefix}<n>** — <text>' in ${section}, got: ${line.slice(0, 60)}`,
		);
	});
	return items;
}

function parseTable(body: string, firstLine: number): TaskTable {
	const lines = body.split("\n");
	const tableEnd = lines.findIndex((line) => !line.startsWith("|"));
	const table = tableEnd === -1 ? lines : lines.slice(0, tableEnd);
	const trailer = tableEnd === -1 ? "" : trimBlank(lines.slice(tableEnd)).join("\n");
	if (table.length < 2 || !SEPARATOR.test(table[1] as string))
		throw new FeatureDocError(`line ${firstLine}: expected the task table, a header row and a '|---|' row.`);
	const columns = splitRow(table[0] as string);
	const rows = table.slice(2).map((line, offset) => {
		const cells = splitRow(line);
		if (cells.length !== columns.length)
			throw new FeatureDocError(
				`line ${firstLine + 2 + offset}: the row has ${cells.length} cells; the table has ${columns.length} columns.`,
			);
		return cells;
	});
	const id = columns.indexOf("ID");
	if (id === -1) throw new FeatureDocError(`line ${firstLine}: the task table has no ID column.`);
	const seen = new Set<string>();
	for (const cells of rows) {
		const value = cells[id] as string;
		if (seen.has(value)) throw new FeatureDocError(`task ${value} appears twice.`);
		seen.add(value);
	}
	return { columns, rows, trailer };
}

function tableText(table: TaskTable): string {
	const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
	const lines = [row(table.columns), `|${table.columns.map(() => "---").join("|")}|`, ...table.rows.map(row)];
	return table.trailer === "" ? lines.join("\n") : `${lines.join("\n")}\n\n${table.trailer}`;
}

function splitRow(line: string): string[] {
	const inner = line
		.trim()
		.replace(/^\|/, "")
		.replace(/(?<!\\)\|$/, "");
	return inner.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

function itemLine(item: Item): string {
	return `- **${item.id}** — ${item.text.split("\n").join("\n  ")}`;
}

function canonicalColumns(doc: FeatureDoc): string[] {
	const columns = doc.tasks.columns;
	const missing = CANONICAL_COLUMNS.filter((column) => !columns.includes(column));
	if (missing.length > 0)
		throw new FeatureDocError(
			`this document's task table has no ${missing.join(", ")} column; Atelier changes only documents with ${CANONICAL_COLUMNS.join(", ")} (Estado holds the status).`,
		);
	return columns;
}

function singleLine(text: string, what: string): string {
	if (/[\r\n]/.test(text)) throw new FeatureDocError(`the ${what} must be a single line.`);
	return text.trim();
}

function escapeCell(text: string): string {
	return text.replaceAll("|", "\\|");
}

function unescapeCell(text: string): string {
	return text.replaceAll("\\|", "|");
}

function trimBlank(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && (lines[start] as string).trim() === "") start++;
	while (end > start && (lines[end - 1] as string).trim() === "") end--;
	return lines.slice(start, end);
}
