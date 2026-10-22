import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type AtelierEventBody, describeError, errorEvent, type JsonValue, PHASES, type Phase } from "../events.ts";
import { writeAtomic } from "../tools/edit.ts";
import { defineTool, type ToolDefinition, type ToolOutcome } from "../tools/types.ts";
import {
	addTask,
	appendLog,
	createFeatureDoc,
	type FeatureDoc,
	FeatureDocError,
	listTasks,
	parseFeatureDoc,
	serializeFeatureDoc,
	TASK_STATUSES,
	updateTask,
} from "./feature-doc.ts";

export const FEATURE_TOOL = "feature";
export const PHASE_TOOL = "phase";
export const ODD_DIR = "odd/tasks";
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/**
 * Shell commands that run tests: the check phase. Matches test runners, not the word "test" anywhere,
 * so reading or writing test/slug.test.js does not count as checking.
 */
const TEST_COMMAND =
	/(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test\b|npm\s+t\b|node\s+--test\b|vitest\b|jest\b|mocha\b|pytest\b|go\s+test\b|cargo\s+test\b|make\s+test\b)/;

interface Active {
	name: string;
	path: string;
	doc: FeatureDoc;
}

type FeatureInput = {
	action: string;
	name?: string | undefined;
	title?: string | undefined;
	header?: string | undefined;
	specs?: string[] | undefined;
	tasks?: { title: string; specs: string[]; route: string }[] | undefined;
	task?: { title: string; specs: string[]; route: string } | undefined;
	id?: string | undefined;
	status?: string | undefined;
	note?: string | undefined;
	commit?: string | undefined;
	text?: string | undefined;
};

class TrackerClosed extends Error {}

/**
 * The ODD state of one session: the active feature document, the phase and
 * the user's words. The document changes only here, and only the user's own
 * messages become user entries in its log.
 *
 * Every change is a transaction (copy, change, write, then commit to memory),
 * and transactions run one at a time in the order they were asked for. So two
 * concurrent tool calls cannot lose each other's change, a failed write leaves
 * memory as it is on disk, and closing waits for what was already asked.
 */
export class OddTracker {
	readonly #cwd: string;
	readonly #emit: (event: AtelierEventBody) => void;
	readonly #userMessages: string[] = [];
	/** How many of the session's user messages the active document already logs. */
	#logged = 0;
	#active: Active | undefined;
	#phase: Phase | undefined;
	#queue: Promise<unknown> = Promise.resolve();
	#closed = false;

	constructor(cwd: string, emit: (event: AtelierEventBody) => void) {
		this.#cwd = cwd;
		this.#emit = emit;
	}

	/**
	 * Records a user prompt as the turn starts. It returns at once, so the turn
	 * is not delayed; the returned promise settles when the prompt is in the
	 * document (or its failure was reported as an event) and never rejects.
	 */
	userMessage(text: string): Promise<void> {
		this.#userMessages.push(text);
		return this.#exclusive(async () => {
			const active = this.#active;
			if (!active) return;
			const doc = copy(active.doc);
			if (!this.#appendPending(doc)) return;
			await this.#write(active.path, doc);
			this.#commit({ ...active, doc });
		}).catch((error: unknown) => {
			if (error instanceof TrackerClosed) return;
			const path = this.#active?.path ?? ODD_DIR;
			this.#emit(errorEvent("odd_log_failed", `Could not log your message in ${path}: ${describeError(error)}`, true));
		});
	}

	/** Infers the phase from a tool about to run. */
	toolStarted(tool: string, input: JsonValue): void {
		const value = (key: string) =>
			typeof input === "object" && input !== null && !Array.isArray(input) ? input[key] : undefined;
		if (tool === "read" || tool === "grep") this.#setPhase("exploring", "inferred");
		else if (tool === "edit") this.#setPhase("implementing", "inferred");
		else if (tool === "bash" && TEST_COMMAND.test(String(value("command") ?? "")))
			this.#setPhase("checking", "inferred");
		else if (tool === "task") this.#setPhase(value("agent") === "explorer" ? "exploring" : "implementing", "inferred");
		else if (tool === FEATURE_TOOL && (value("action") === "start" || value("action") === "add_task"))
			this.#setPhase("planning", "inferred");
	}

	/** Waits for every change already asked for, then refuses new ones. */
	close(): Promise<void> {
		this.#closed = true;
		return this.#queue.then(() => {});
	}

	tools(): ToolDefinition[] {
		return [this.#featureTool(), this.#phaseTool()];
	}

	#exclusive<T>(run: () => Promise<T>): Promise<T> {
		if (this.#closed) return Promise.reject(new TrackerClosed("The session is closed."));
		const result = this.#queue.then(run);
		this.#queue = result.catch(() => {});
		return result;
	}

	#setPhase(phase: Phase, source: "inferred" | "declared"): void {
		if (this.#phase === phase) return;
		this.#phase = phase;
		this.#emit({ type: "phase_changed", phase, source });
	}

	#phaseTool(): ToolDefinition {
		return defineTool({
			name: PHASE_TOOL,
			description:
				"Declares the ODD phase when the tools cannot show it: authorizing (checking you may change things), deciding (waiting on a user decision), planning, closing (reporting the outcome). Reading, editing and running tests set their phase on their own.",
			inputShape: { phase: z.enum(PHASES).describe("The phase you are in now") },
			execute: async ({ phase }) => {
				this.#setPhase(phase, "declared");
				return done(`Phase: ${phase}.`);
			},
		});
	}

	#featureTool(): ToolDefinition {
		const task = z.object({
			title: z.string().describe("What the task delivers, one line"),
			specs: z.array(z.string()).describe("Spec ids it covers, like S1"),
			route: z.string().describe("inline, explorer or worker"),
		});
		return defineTool({
			name: FEATURE_TOOL,
			description: [
				`Tracks a large piece of work in its feature document, ${ODD_DIR}/<name>.md. This tool is the only way to change it.`,
				"start: create it (name, title, header, specs, tasks). Copy the user's exact words into the specs; the user's messages are logged verbatim for you.",
				"open: resume an existing one by name. show: the active one. Both return its specs and tasks.",
				"add_task (task), update_task (id, status, note, commit), log (text: your own note).",
				`Statuses: ${TASK_STATUSES.join(", ")}; blocked needs a note.`,
			].join("\n"),
			inputShape: {
				action: z.enum(["start", "open", "add_task", "update_task", "log", "show"]),
				name: z.string().optional().describe("start, open: lowercase-with-dashes"),
				title: z.string().optional().describe("start"),
				header: z.string().optional().describe("start: one to three lines"),
				specs: z.array(z.string()).optional().describe("start: S1, S2... in order"),
				tasks: z.array(task).optional().describe("start"),
				task: task.optional().describe("add_task"),
				id: z.string().optional().describe("update_task: T1..."),
				status: z.string().optional().describe("update_task"),
				note: z.string().optional().describe("update_task"),
				commit: z.string().optional().describe("update_task: the commit that holds the task"),
				text: z.string().optional().describe("log"),
			},
			execute: (input) =>
				this.#exclusive(() => this.#run(input)).catch((error: unknown) => {
					if (error instanceof TrackerClosed || error instanceof FeatureDocError) return failed(error.message);
					throw error;
				}),
		});
	}

	async #run(input: FeatureInput): Promise<ToolOutcome> {
		if (input.action === "start" || input.action === "open") {
			const name = input.name ?? "";
			if (!NAME.test(name)) return failed("name must be lowercase letters, digits and dashes, like slug-accents.");
			const path = `${ODD_DIR}/${name}.md`;
			const existing = await readFile(join(this.#cwd, path), "utf8").catch(() => undefined);
			let doc: FeatureDoc;
			if (input.action === "start") {
				if (existing !== undefined) return failed(`${path} already exists; use open to resume it.`);
				doc = createFeatureDoc({
					title: input.title ?? "",
					header: input.header ?? "",
					specs: input.specs ?? [],
					tasks: input.tasks ?? [],
				});
			} else {
				if (existing === undefined) return failed(`${path} does not exist.`);
				doc = parseFeatureDoc(existing);
			}
			// A document new to this session gets every user message of the session, L1 first.
			const added = this.#appendPending(doc, 0);
			if (input.action === "start" || added) await this.#write(path, doc);
			const active = { name, path, doc };
			this.#commit(active);
			return done(`${input.action === "start" ? "Started" : "Opened"} ${path}.\n${summary(active, true)}`);
		}

		const active = this.#active;
		if (!active) return failed("no feature is active; start or open one first.");
		if (input.action === "show") return done(summary(active, true));
		const doc = copy(active.doc);
		switch (input.action) {
			case "add_task":
				if (!input.task) return failed("add_task needs task.");
				addTask(doc, input.task);
				break;
			case "update_task":
				updateTask(doc, {
					id: input.id ?? "",
					status: (input.status ?? "") as never,
					...(input.note === undefined ? {} : { note: input.note }),
					...(input.commit === undefined ? {} : { commit: input.commit }),
				});
				break;
			case "log":
				if (!input.text?.trim()) return failed("log needs text.");
				appendLog(doc, "agent", input.text);
				break;
			default:
				return failed(`unknown action ${input.action}.`);
		}
		await this.#write(active.path, doc);
		const next = { ...active, doc };
		this.#commit(next);
		return done(summary(next, false));
	}

	/** Appends, verbatim and in order, the user messages from `from` on. Returns whether it added any. */
	#appendPending(doc: FeatureDoc, from = this.#logged): boolean {
		const pending = this.#userMessages.slice(from);
		for (const message of pending) appendLog(doc, "user", message);
		return pending.length > 0;
	}

	/** Makes a written document the active one; only called after its write succeeded. */
	#commit(active: Active): void {
		this.#active = active;
		this.#logged = this.#userMessages.length;
		this.#changed(active);
	}

	async #write(path: string, doc: FeatureDoc): Promise<void> {
		await mkdir(join(this.#cwd, ODD_DIR), { recursive: true });
		await writeAtomic(join(this.#cwd, path), serializeFeatureDoc(doc), 0o644);
	}

	#changed(active: Active): void {
		this.#emit({
			type: "feature_changed",
			name: active.name,
			path: active.path,
			title: active.doc.title,
			tasks: listTasks(active.doc).map((task) => ({
				id: task.id,
				title: task.title,
				specs: task.specs,
				...(task.status === undefined ? {} : { status: task.status }),
				...(task.commit === undefined ? {} : { commit: task.commit }),
			})),
		});
	}
}

function copy(doc: FeatureDoc): FeatureDoc {
	return parseFeatureDoc(serializeFeatureDoc(doc));
}

/** Compact state: tasks, and the specs when the model needs them to work (open, show); never the whole log. */
function summary(active: Active, withSpecs: boolean): string {
	const specs = withSpecs ? ["Specs:", ...active.doc.specs.map((spec) => `${spec.id} — ${spec.text}`), "Tasks:"] : [];
	const tasks = listTasks(active.doc).map(
		(task) =>
			`${task.id} [${task.status ?? "?"}] ${task.title}${task.specs.length > 0 ? ` (${task.specs.join(", ")})` : ""}`,
	);
	return [`${active.doc.title} — ${active.path}`, ...specs, ...tasks, `Log: ${active.doc.log.length} entries.`].join(
		"\n",
	);
}

function done(output: string): ToolOutcome {
	return { ok: true, output, summary: output.split("\n")[0] ?? "", truncated: false };
}

function failed(output: string): ToolOutcome {
	return { ok: false, output, summary: output, truncated: false };
}
