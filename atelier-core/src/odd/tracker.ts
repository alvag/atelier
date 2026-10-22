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
/** Shell commands that run tests: the check phase. */
const TEST_COMMAND = /\b(test|tests|vitest|jest|pytest|mocha|go test|cargo test|npm t)\b/;

interface Active {
	name: string;
	path: string;
	doc: FeatureDoc;
}

/**
 * The ODD state of one session: the active feature document, the phase and
 * the user's words. The document changes only here, and only the user's own
 * messages become user entries in its log.
 */
export class OddTracker {
	readonly #cwd: string;
	readonly #emit: (event: AtelierEventBody) => void;
	readonly #userMessages: string[] = [];
	/** How many of the session's user messages the active document already logs. */
	#logged = 0;
	#active: Active | undefined;
	#phase: Phase | undefined;
	/** Writes run one after another, so an older document never lands after a newer one. */
	#queue: Promise<void> = Promise.resolve();

	constructor(cwd: string, emit: (event: AtelierEventBody) => void) {
		this.#cwd = cwd;
		this.#emit = emit;
	}

	/**
	 * Called with every user prompt as the turn starts. Synchronous, so it never
	 * delays the turn; the write is queued and a failure is reported as an event.
	 */
	userMessage(text: string): void {
		this.#userMessages.push(text);
		const active = this.#active;
		if (!active || !this.#logUserMessages(active)) return;
		this.#changed(active);
		this.#persist(active).catch((error: unknown) =>
			this.#emit(errorEvent("odd_log_failed", `Could not write ${active.path}: ${describeError(error)}`, true)),
		);
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

	/** Resolves once every queued write has finished (they report their own errors). */
	flush(): Promise<void> {
		return this.#queue;
	}

	tools(): ToolDefinition[] {
		return [this.#featureTool(), this.#phaseTool()];
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
				"open: resume an existing one by name; returns the whole document. show: the active document.",
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
			execute: async (input) => {
				try {
					return await this.#run(input);
				} catch (error) {
					if (error instanceof FeatureDocError) return failed(error.message);
					throw error;
				}
			},
		});
	}

	async #run(input: {
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
	}): Promise<ToolOutcome> {
		if (input.action === "start" || input.action === "open") {
			const name = input.name ?? "";
			if (!NAME.test(name)) return failed("name must be lowercase letters, digits and dashes, like slug-accents.");
			const path = `${ODD_DIR}/${name}.md`;
			const absolute = join(this.#cwd, path);
			if (input.action === "start") {
				const exists = await readFile(absolute, "utf8").then(
					() => true,
					() => false,
				);
				if (exists) return failed(`${path} already exists; use open to resume it.`);
				const doc = createFeatureDoc({
					title: input.title ?? "",
					header: input.header ?? "",
					specs: input.specs ?? [],
					tasks: input.tasks ?? [],
				});
				const active = { name, path, doc };
				const logged = this.#logged;
				this.#logged = 0;
				this.#logUserMessages(active);
				try {
					await this.#persist(active);
				} catch (error) {
					this.#logged = logged;
					throw error;
				}
				this.#active = active;
				this.#changed(active);
				return done(`Started ${path}.\n${summary(active)}`);
			}
			const text = await readFile(absolute, "utf8").catch(() => undefined);
			if (text === undefined) return failed(`${path} does not exist.`);
			const doc = parseFeatureDoc(text);
			const active = { name, path, doc };
			this.#logged = 0;
			this.#active = active;
			if (this.#logUserMessages(active)) await this.#persist(active);
			this.#changed(active);
			return done(`Opened ${path}:\n\n${serializeFeatureDoc(active.doc)}`);
		}

		const active = this.#active;
		if (!active) return failed("no feature is active; start or open one first.");
		// Work on a copy so a rejected change leaves the document as it was.
		const doc = parseFeatureDoc(serializeFeatureDoc(active.doc));
		switch (input.action) {
			case "show":
				return done(serializeFeatureDoc(active.doc));
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
		const next = { ...active, doc };
		await this.#persist(next);
		this.#active = next;
		this.#changed(next);
		return done(summary(next));
	}

	/** Logs, verbatim and in order, the session's user messages the document does not have yet. Returns whether it added any. */
	#logUserMessages(active: Active): boolean {
		if (this.#logged >= this.#userMessages.length) return false;
		for (const message of this.#userMessages.slice(this.#logged)) appendLog(active.doc, "user", message);
		this.#logged = this.#userMessages.length;
		return true;
	}

	/** Queues a write of the document as it is when the write runs. */
	#persist(active: Active): Promise<void> {
		const write = this.#queue.then(async () => {
			await mkdir(join(this.#cwd, ODD_DIR), { recursive: true });
			await writeAtomic(join(this.#cwd, active.path), serializeFeatureDoc(active.doc), 0o644);
		});
		this.#queue = write.catch(() => {});
		return write;
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

function summary(active: Active): string {
	const lines = listTasks(active.doc).map(
		(task) =>
			`${task.id} [${task.status ?? "?"}] ${task.title}${task.specs.length > 0 ? ` (${task.specs.join(", ")})` : ""}`,
	);
	return [`${active.doc.title} — ${active.path}`, ...lines, `Log: ${active.doc.log.length} entries.`].join("\n");
}

function done(output: string): ToolOutcome {
	return { ok: true, output, summary: output.split("\n")[0] ?? "", truncated: false };
}

function failed(output: string): ToolOutcome {
	return { ok: false, output, summary: output, truncated: false };
}
