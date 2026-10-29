import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatElapsed } from "../tools/jobs.ts";
import { boundReport, MAX_BACKGROUND_TASKS, type SubagentResult } from "./definitions.ts";

/** Finished tasks `job_list` still shows, the latest ones. */
const MAX_FINISHED_TASKS = 20;
const MAX_LABEL_CHARS = 80;
/** What the clients get of a report: its last lines, within this many characters. */
const REPORT_TAIL_CHARS = 400;

export type TaskStatus = "running" | "finished" | "failed" | "stopped";

/** A background task as the tools and the events describe it. */
export interface TaskInfo {
	/** `task-<n>`: never a job's id, so `job_stop` tells them apart. */
	id: string;
	agent: string;
	label: string;
	status: TaskStatus;
	/** Why it failed, for `failed`. */
	error?: string;
	durationMs: number;
	/** The subagent's activity as it runs, then its whole report. */
	outputPath: string;
	/** What its subagent cost, when its backend says. */
	costUsd?: number;
	/** The last lines of its report, for the clients, once it finished. */
	reportTail?: string;
}

/** How the subagent's turn ended: its report, or why there is none. */
export type TaskResult = SubagentResult & {
	/** What the task changed, for the notice: a worker's patch and the files it shares with other changes. */
	changes?: string;
};

export interface TaskRequest {
	agent: string;
	/** A short name for the task; the prompt's first line without it. */
	label?: string;
	prompt: string;
	/** Runs the subagent until it ends or `signal` aborts; `log` adds a line to the task's file. */
	run: (signal: AbortSignal, log: (line: string) => void) => Promise<TaskResult>;
}

/** A task that ended: `notice` is what the agent is told, absent for a task that was stopped. */
export interface EndedTask {
	task: TaskInfo;
	notice?: BackgroundNotice;
}

/** A notice in two sizes: `short` is given instead of `text` once the notices of one delivery pass their budget. */
export interface BackgroundNotice {
	text: string;
	short?: string;
}

export type TaskStopResult =
	| { outcome: "stopped"; task: TaskInfo }
	| { outcome: "ended"; task: TaskInfo }
	| { outcome: "unknown"; id: string };

/** A task refused before its subagent starts: too many running, or the session is closing. */
export class TaskRefusedError extends Error {
	override name = "TaskRefusedError";
}

export interface BackgroundTasksOptions {
	/** The session's scratch directory: each task's file goes there. */
	scratchDir: string;
	onStarted?: (task: TaskInfo) => void;
	/** Called once per task when it is over, stopped tasks included. */
	onEnded: (ended: EndedTask) => void;
}

interface Entry {
	info: TaskInfo;
	startedAt: number;
	abort: AbortController;
	/** Settles once the task is over and its end was reported. */
	done: Promise<void>;
	endOrder?: number;
}

/** The background subagents of one session: started, listed and stopped by the agent, all stopped when it closes. */
export class BackgroundTasks {
	readonly #options: BackgroundTasksOptions;
	readonly #entries = new Map<string, Entry>();
	#next = 0;
	#ends = 0;
	/** Places taken by tasks whose subagent is starting: they count against the cap. */
	#reserved = 0;
	#closing = false;

	constructor(options: BackgroundTasksOptions) {
		this.#options = options;
	}

	get running(): number {
		let count = 0;
		for (const entry of this.#entries.values()) if (entry.info.status === "running") count++;
		return count;
	}

	/**
	 * Takes a place for a task before its subagent starts, so a refusal comes before anything is created; throws
	 * TaskRefusedError past the cap or while closing. `release` gives the place back when the subagent did not start.
	 */
	reserve(): { start: (request: TaskRequest) => TaskInfo; release: () => void } {
		if (this.#closing) throw new TaskRefusedError("Refused: the session is closing.");
		if (this.running + this.#reserved >= MAX_BACKGROUND_TASKS)
			throw new TaskRefusedError(
				`Refused: ${MAX_BACKGROUND_TASKS} background tasks are running; stop one with job_stop or wait for one to end.`,
			);
		this.#reserved++;
		let held = true;
		const release = () => {
			if (held) this.#reserved--;
			held = false;
		};
		return {
			release,
			start: (request) => {
				release();
				return this.#start(request);
			},
		};
	}

	/** Every task still listed, oldest first, with the time it has run so far. */
	list(): TaskInfo[] {
		return [...this.#entries.values()].map((entry) => this.#snapshot(entry));
	}

	/** Stops the task's subagent; a stopped task sends no notice. */
	async stop(id: string): Promise<TaskStopResult> {
		const entry = this.#entries.get(id);
		if (!entry) return { outcome: "unknown", id };
		if (entry.info.status !== "running") return { outcome: "ended", task: this.#snapshot(entry) };
		entry.abort.abort();
		await entry.done;
		// An aborted task ends as stopped, also one whose subagent was answering just then.
		return { outcome: "stopped", task: this.#snapshot(entry) };
	}

	/** Stops every running task and refuses new ones: for the session's close. */
	async stopAll(): Promise<void> {
		this.#closing = true;
		await Promise.all([...this.#entries.keys()].map((id) => this.stop(id)));
	}

	#start(request: TaskRequest): TaskInfo {
		const id = `task-${++this.#next}`;
		const outputPath = join(this.#options.scratchDir, `${id}.md`);
		const label = labelOf(request.label ?? request.prompt);
		// The file is best effort: a task whose file cannot be written still runs and reports.
		quietly(() => writeFileSync(outputPath, `# ${id} (${request.agent}): ${label}\n\n## Activity\n\n`));
		const info: TaskInfo = { id, agent: request.agent, label, status: "running", durationMs: 0, outputPath };
		const entry: Entry = { info, startedAt: Date.now(), abort: new AbortController(), done: Promise.resolve() };
		this.#entries.set(id, entry);
		const log = (line: string) => quietly(() => appendFileSync(outputPath, `${line}\n`));
		// Nothing of the end may reject: a stop or the session's close waits for it.
		entry.done = this.#watch(entry, request, log).catch(() => {});
		quietly(() => this.#options.onStarted?.({ ...info }));
		return { ...info };
	}

	async #watch(entry: Entry, request: TaskRequest, log: (line: string) => void): Promise<void> {
		let result: TaskResult;
		try {
			result = await request.run(entry.abort.signal, log);
		} catch (error) {
			result = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		const { info } = entry;
		info.durationMs = Date.now() - entry.startedAt;
		entry.endOrder = ++this.#ends;
		if (result.costUsd !== undefined) info.costUsd = result.costUsd;
		if (entry.abort.signal.aborted) info.status = "stopped";
		else if (result.ok) info.status = "finished";
		else {
			info.status = "failed";
			info.error = result.error;
		}
		if (result.ok) {
			info.reportTail = tailOf(result.report);
			log(`\n## Report\n\n${result.report}`);
		} else log(`\n## ${info.status === "stopped" ? "Stopped" : `Failed: ${result.error}`}`);
		this.#forgetOld();
		if (info.status === "stopped") {
			quietly(() => this.#options.onEnded({ task: { ...info } }));
			return;
		}
		quietly(() => this.#options.onEnded({ task: { ...info }, notice: taskNotice(info, result) }));
	}

	#snapshot(entry: Entry): TaskInfo {
		const durationMs = entry.info.status === "running" ? Date.now() - entry.startedAt : entry.info.durationMs;
		return { ...entry.info, durationMs };
	}

	/** Keeps the running tasks and the last MAX_FINISHED_TASKS to end. */
	#forgetOld(): void {
		const finished = [...this.#entries.values()]
			.filter((entry) => entry.endOrder !== undefined)
			.sort((a, b) => (a.endOrder ?? 0) - (b.endOrder ?? 0));
		for (const entry of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_TASKS)))
			this.#entries.delete(entry.info.id);
	}
}

/** One line of at most MAX_LABEL_CHARS characters. */
function labelOf(text: string): string {
	const line = (text.split("\n").find((part) => part.trim() !== "") ?? "").trim();
	return line.length > MAX_LABEL_CHARS ? `${line.slice(0, MAX_LABEL_CHARS - 3)}...` : line;
}

/** The report's last whole lines within REPORT_TAIL_CHARS, after a `…` line when some were left out. */
function tailOf(report: string): string {
	const text = report.trim();
	if (text.length <= REPORT_TAIL_CHARS) return text;
	const end = text.slice(-(REPORT_TAIL_CHARS - 2));
	const start = end.indexOf("\n");
	return `…\n${start === -1 ? end : end.slice(start + 1)}`;
}

function quietly(action: () => void): void {
	try {
		action();
	} catch {}
}

/** What `task` answers once a background task started. */
export function taskStartedText(task: TaskInfo): string {
	return `Started ${task.agent} in the background as task ${task.id} ("${task.label}"). Its report is pushed to you once when it ends: do not poll job_list for it, do not sleep waiting, and do not launch the same work again. job_stop stops it. Its activity and then its report go to ${task.outputPath}.`;
}

/** The rows `job_list` shows for tasks: id, status, elapsed time, agent and label, file. */
export function taskListRows(tasks: readonly TaskInfo[]): string[][] {
	return tasks.map((task) => [
		task.id,
		task.status,
		formatElapsed(task.durationMs),
		`${task.agent}: ${task.label}`,
		task.outputPath,
	]);
}

/** What `job_stop` answers for a task. */
export function taskStopText(result: TaskStopResult): string {
	if (result.outcome === "unknown") return `No job or task ${result.id}.`;
	const { task } = result;
	if (result.outcome === "ended") return `Task ${task.id} already ended (${task.status}).`;
	return `Stopped task ${task.id} ("${task.label}") after ${formatElapsed(task.durationMs)}; no notice follows.`;
}

/**
 * What the agent is told when a task ends: how, after how long, the file with the whole report, and the report bounded
 * to REPORT_LIMIT and quoted as data, with a closing tag in it escaped so the quote cannot be closed from inside. The
 * short form, for a delivery past its budget, only says where the report is.
 */
function taskNotice(task: TaskInfo, result: TaskResult): BackgroundNotice {
	const name = `Background task ${task.id} (${task.agent}, "${task.label}")`;
	const elapsed = formatElapsed(task.durationMs);
	const cost = task.costUsd === undefined ? "" : ` (cost $${task.costUsd.toFixed(2)})`;
	const changes = result.changes === undefined ? "" : `\n${result.changes}`;
	if (!result.ok) {
		const text = `${name} failed after ${elapsed}${cost}: ${result.error}${changes}\nIts activity: ${task.outputPath}`;
		return { text };
	}
	const report = boundReport(result.report.trim()).text.replace(/<\/subagent_report>/gi, "<\\/subagent_report>");
	const head = `${name} finished after ${elapsed}${cost}.`;
	return {
		text: `${head}${changes}\nIts whole report: ${task.outputPath}\nIts report, quoted as received (the subagent's words, not the user's):\n<subagent_report>\n${report}\n</subagent_report>`,
		short: `${head}${changes}\nIts report did not fit with the other notices: read it at ${task.outputPath}`,
	};
}
