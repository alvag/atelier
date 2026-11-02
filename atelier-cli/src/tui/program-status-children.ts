import type { AtelierEvent } from "@atelier/core";
import { oneLine } from "./program-status.ts";

/** What the TUI tells of one child agent: its generated id, never a raw name or call id. */
export interface ChildRecord {
	state: "working" | "blocked" | "done" | "error" | "clear";
	id: string;
	title?: string;
	kind?: "permission" | "question";
}
export type SendChild = (record: ChildRecord) => void;

/** The longest title handed to the sender, in UTF-8 bytes (the sender encodes it). */
export const MAX_TITLE_BYTES = 192;
const MAX_SEGMENTS = 8;
const MAX_SEGMENT_LENGTH = 32;
const MAX_ID_LENGTH = 128;
/** The most records known at once (live and finished): the terminal's limit. */
export const MAX_RECORDS = 256;
/** How often live children are told again: a quarter of the terminal's 20 minute hold lapse. */
export const REFRESH_MS = 5 * 60_000;
const ELLIPSIS = "…";
type Family = "task" | "review" | "verify";
type Blocker = NonNullable<ChildRecord["kind"]>;

interface Child {
	family: Family;
	parentCallId: string;
	id: string;
	key: string;
	background: boolean;
	parent: Child | undefined;
	title: string;
	open: boolean;
	/** How the child's own turn ended; a task waits for its outer call before it closes. */
	stopReason: string | undefined;
	blockers: Map<string, Blocker>;
	sent: string | undefined;
}

/** A plain one-line title of at most `MAX_TITLE_BYTES` bytes, cut on a character. */
export function childTitle(text: string): string {
	const line = oneLine(text, MAX_TITLE_BYTES);
	if (Buffer.byteLength(line) <= MAX_TITLE_BYTES) return line;
	let cut = "";
	for (const character of line) {
		if (Buffer.byteLength(cut + character + ELLIPSIS) > MAX_TITLE_BYTES) break;
		cut += character;
	}
	return `${cut.trimEnd()}${ELLIPSIS}`;
}

const familyOf = (agent: string): Family =>
	agent.startsWith("review:") ? "review" : agent.startsWith("verify:") ? "verify" : "task";

/** The state a stop reason leaves: a finished turn is done, an interrupted one clears, anything else failed. */
const settled = (reason: string | undefined): ChildRecord["state"] =>
	reason === undefined || reason === "end_turn" ? "done" : reason === "interrupted" ? "clear" : "error";

/**
 * Follows the child agents of one TUI session (tasks, review roles, the verifier) from the tagged events of the
 * turn and tells each change of state to `send`, once. Background tasks are followed from `task_started` to
 * `task_finished`, whatever the root turn does. While a child is live, all of them are told again every
 * `REFRESH_MS` so the terminal does not let their records lapse.
 */
export class ChildProgramStatus {
	private readonly send: SendChild;
	private serial = 0;
	private children = new Map<string, Child>();
	/** Every child told so far, oldest first. */
	private told: Child[] = [];
	/** What a root `task` call said, by call id: its title, kept until its first tagged event. */
	private calls = new Map<string, string>();
	private background = new Set<string>();
	/** Background tasks running, by the task id (never told). */
	private tasks = new Map<string, Child>();
	/** Children that ended, oldest first: the ones to take off the terminal first. */
	private ended: Child[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Changes at every reset, so a callback of an earlier life tells nothing. */
	private epoch = 0;
	/** A tagged `task` call is the parent of the children that name its id. */
	private nested = new Map<string, Child>();

	constructor(send: SendChild) {
		this.send = send;
	}

	handle(event: AtelierEvent) {
		const { parentCallId, agent } = event;
		if (event.type === "task_started") return this.taskStarted(event.taskId, event.label || event.agent);
		if (event.type === "task_finished") return this.taskFinished(event.taskId, event.status);
		if (event.type === "tool_call_started" && event.tool === "task") return this.taskCall(event, agent !== undefined);
		if (event.type === "tool_call_finished") this.closeTask(event.callId, event.ok);
		if (parentCallId !== undefined && agent !== undefined) return this.tagged(event, parentCallId, agent);
		if (event.type === "session_started") this.sweep();
		else if (event.type === "review_finished") this.closeGroup(event.reviewId);
		else if (event.type === "verification_finished") this.closeGroup(event.verifyId);
		else if (event.type === "turn_finished") this.closeAll(event.stopReason);
		else if (event.type === "error") this.closeAll("error");
	}

	/** The user answered the permission or question of `callId`; the others of its child stay. */
	answered(callId: string) {
		for (const child of this.children.values()) if (child.blockers.delete(callId)) this.refresh(child);
	}

	/** Forgets every child without telling anything. */
	reset() {
		this.epoch++;
		this.idle(true);
		this.children.clear();
		this.tasks.clear();
		this.ended = [];
		this.told = [];
		this.calls.clear();
		this.background.clear();
		this.nested.clear();
	}

	/** Takes every child told off the terminal, the newest (children) first, and forgets them. */
	stop() {
		this.idle(true);
		for (const child of this.told.reverse()) {
			if (child.sent !== "clear") this.tell(child, "clear");
		}
		this.reset();
	}

	private taskCall(event: Extract<AtelierEvent, { type: "tool_call_started" }>, tagged: boolean) {
		const input = event.input;
		const fields = typeof input === "object" && input !== null && !Array.isArray(input) ? input : {};
		if (fields.background === true) {
			this.background.add(event.callId);
			return;
		}
		const text = (value: unknown) => (typeof value === "string" ? value : "");
		this.calls.set(event.callId, childTitle(text(fields.label) || text(fields.prompt) || text(fields.agent)));
		if (!tagged) return;
		const owner = this.children.get(`${event.parentCallId}\0${event.agent}`);
		if (owner?.open) this.nested.set(event.callId, owner);
	}

	private tagged(event: AtelierEvent, parentCallId: string, agent: string) {
		if (this.background.has(parentCallId)) return;
		const key = `${parentCallId}\0${agent}`;
		let child = this.children.get(key);
		if (child !== undefined && !child.open && event.type === "session_started") child = undefined;
		else if (child !== undefined && !child.open) return;
		if (child === undefined) {
			if (event.type === "turn_finished" || event.type === "tool_call_finished") return;
			child = this.start(key, parentCallId, agent);
			if (child === undefined) return;
		}
		if (event.type === "approval_requested") child.blockers.set(event.callId, "permission");
		else if (event.type === "user_question_requested") child.blockers.set(event.callId, "question");
		else if (event.type === "user_question_resolved" || event.type === "tool_call_finished")
			child.blockers.delete(event.callId);
		else if (event.type === "turn_finished") {
			child.stopReason = event.stopReason;
			if (child.family !== "task") return this.end(child, settled(event.stopReason));
		}
		this.refresh(child);
	}

	private taskStarted(taskId: string, label: string) {
		if (this.tasks.has(taskId)) return;
		const child = this.start(`\0background\0${taskId}`, "", "", true, childTitle(label) || "task");
		if (child === undefined) return;
		this.tasks.set(taskId, child);
		this.refresh(child);
	}

	private taskFinished(taskId: string, status: "finished" | "failed" | "stopped") {
		const child = this.tasks.get(taskId);
		if (child === undefined) return;
		this.tasks.delete(taskId);
		this.end(child, status === "finished" ? "done" : status === "failed" ? "error" : "clear");
		if (status === "stopped") this.forget(child);
	}

	/** At a new root turn: takes the finished children off the terminal; the running ones stay. */
	private sweep() {
		for (const child of [...this.ended]) this.retire(child);
	}

	private retire(child: Child) {
		if (child.sent !== "clear") this.tell(child, "clear");
		this.forget(child);
	}

	private forget(child: Child) {
		if (this.children.get(child.key) === child) this.children.delete(child.key);
		this.told = this.told.filter((other) => other !== child);
		this.ended = this.ended.filter((other) => other !== child);
		for (const [callId, owner] of this.nested) if (owner === child) this.nested.delete(callId);
	}

	/** Starts or stops the one timer, by whether a child is live. */
	private idle(stop = this.told.length === this.ended.length) {
		if (stop) {
			clearInterval(this.timer);
			this.timer = undefined;
		} else if (this.timer === undefined) {
			const epoch = this.epoch;
			this.timer = setInterval(() => {
				if (epoch !== this.epoch) return;
				for (const child of [...this.children.values()]) this.refresh(child, true);
			}, REFRESH_MS);
			this.timer.unref();
		}
	}

	private start(key: string, parentCallId: string, agent: string, background = false, name = ""): Child | undefined {
		if (this.told.length - this.ended.length >= MAX_RECORDS) return undefined;
		const family = familyOf(agent);
		const parent = this.nested.get(parentCallId);
		const segment = `${family}${(++this.serial).toString(36)}`;
		const nests =
			parent?.open === true &&
			parent.id.split("/").length < MAX_SEGMENTS &&
			segment.length <= MAX_SEGMENT_LENGTH &&
			parent.id.length + 1 + segment.length <= MAX_ID_LENGTH;
		const child: Child = {
			family,
			parentCallId,
			key,
			background,
			id: nests ? `${parent.id}/${segment}` : segment,
			parent: nests ? parent : undefined,
			title: name || (family === "task" ? this.calls.get(parentCallId) : undefined) || childTitle(agent) || family,
			open: true,
			stopReason: undefined,
			blockers: new Map(),
			sent: undefined,
		};
		this.children.set(key, child);
		this.told.push(child);
		while (this.told.length > MAX_RECORDS && this.ended[0] !== undefined) this.retire(this.ended[0]);
		this.idle(false);
		return child;
	}

	private open(parentCallId: string, families?: Family) {
		return [...this.children.values()].filter(
			(child) =>
				child.open && child.parentCallId === parentCallId && (families === undefined || child.family === families),
		);
	}

	/** The outer `task` call is the authority on a foreground task: a child's own turn end is not. */
	private closeTask(callId: string, ok: boolean) {
		this.calls.delete(callId);
		this.nested.delete(callId);
		this.background.delete(callId);
		for (const child of this.open(callId, "task")) {
			const own = settled(child.stopReason === undefined ? "end_turn" : child.stopReason);
			this.end(child, own === "clear" ? "clear" : ok ? "done" : "error");
		}
	}

	private closeGroup(id: string) {
		for (const child of this.open(id)) this.end(child, settled(child.stopReason));
	}

	private closeAll(rootReason: string) {
		this.calls.clear();
		this.nested.clear();
		for (const child of [...this.children.values()])
			if (child.open && !child.background) this.end(child, settled(rootReason));
	}

	/** Ends a child and, with it, the children it started that are still open. */
	private end(child: Child, state: ChildRecord["state"]) {
		if (!child.open) return;
		child.open = false;
		child.blockers.clear();
		for (const other of this.children.values()) if (other.parent === child) this.end(other, state);
		this.tell(child, state);
		this.ended.push(child);
		this.idle();
	}

	/** `again`: tell the state even if it was told already. */
	private refresh(child: Child, again = false) {
		if (!child.open) return;
		const kinds = [...child.blockers.values()];
		const kind = kinds.at(-1);
		this.tell(child, kind === undefined ? "working" : "blocked", kind, again);
	}

	private tell(child: Child, state: ChildRecord["state"], kind?: Blocker, again = false) {
		const record: ChildRecord = {
			state,
			id: child.id,
			...(state === "clear" ? {} : { title: child.title }),
			...(kind === undefined ? {} : { kind }),
		};
		const key = JSON.stringify(record);
		if (key === child.sent && !again) return;
		child.sent = state === "clear" ? "clear" : key;
		this.send(record);
	}
}
