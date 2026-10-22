/**
 * Atelier's memory interface. The core talks only to this; one adapter
 * implements it against the memory service, and nothing else knows which.
 */

export const MEMORY_TYPES = [
	"decision",
	"bugfix",
	"discovery",
	"pattern",
	"preference",
	"architecture",
	"config",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryHit {
	id: number;
	title: string;
	type: string;
	preview: string;
}

export interface MemoryEntry {
	id: number;
	title: string;
	type: string;
	content: string;
	topicKey?: string;
}

export interface NewMemory {
	title: string;
	type: MemoryType;
	content: string;
	/** Saving again with the same key updates that entry instead of adding one. */
	topicKey?: string;
}

export interface MemoryPort {
	/** The project the memories belong to, as the memory service resolved it for the session folder. */
	readonly project: string;
	/** Recent memory of the project, at most `maxBytes` bytes. */
	context(maxBytes: number): Promise<string>;
	search(query: string, limit: number): Promise<MemoryHit[]>;
	get(id: number): Promise<MemoryEntry | undefined>;
	save(entry: NewMemory): Promise<{ id: number }>;
	summary(text: string): Promise<void>;
	close(): Promise<void>;
}

/** Memory cannot be used in this session; the message says why. Sessions go on without it. */
export class MemoryUnavailableError extends Error {
	override name = "MemoryUnavailableError";
}

/** A memory call failed or the service answered something unexpected. */
export class MemoryError extends Error {
	override name = "MemoryError";
}

/** In-memory MemoryPort for tests. */
export class FakeMemory implements MemoryPort {
	readonly project: string;
	readonly entries: MemoryEntry[] = [];
	readonly summaries: string[] = [];
	closed = false;

	constructor(project = "fake") {
		this.project = project;
	}

	async context(maxBytes: number): Promise<string> {
		const text = this.entries.map((entry) => `- [${entry.type}] ${entry.title}`).join("\n");
		return Buffer.from(text).subarray(0, maxBytes).toString("utf8");
	}

	async search(query: string, limit: number): Promise<MemoryHit[]> {
		const needle = query.toLowerCase();
		return this.entries
			.filter((entry) => `${entry.title}\n${entry.content}`.toLowerCase().includes(needle))
			.slice(0, limit)
			.map(({ id, title, type, content }) => ({ id, title, type, preview: content.slice(0, 200) }));
	}

	async get(id: number): Promise<MemoryEntry | undefined> {
		const entry = this.entries.find((candidate) => candidate.id === id);
		return entry && { ...entry };
	}

	async save(entry: NewMemory): Promise<{ id: number }> {
		const existing =
			entry.topicKey === undefined
				? undefined
				: this.entries.find((candidate) => candidate.topicKey === entry.topicKey);
		if (existing) {
			Object.assign(existing, { title: entry.title, type: entry.type, content: entry.content });
			return { id: existing.id };
		}
		const id = this.entries.length + 1;
		this.entries.push({
			id,
			title: entry.title,
			type: entry.type,
			content: entry.content,
			...(entry.topicKey === undefined ? {} : { topicKey: entry.topicKey }),
		});
		return { id };
	}

	async summary(text: string): Promise<void> {
		this.summaries.push(text);
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}
