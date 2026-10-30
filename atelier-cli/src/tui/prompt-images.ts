import { MAX_PROMPT_IMAGE_BYTES, MAX_PROMPT_IMAGES, type PreparedImage } from "@atelier/core";

const MARKER = /\[Image #(\d+)\]/g;

/** What a draft sends: its text without the markers of images it holds, and those images. */
export interface ImageDraft {
	prompt: string;
	ids: number[];
	images: PreparedImage["image"][];
}

/**
 * The images pasted into the editor, by the number in the `[Image #n]` marker that stands for each in its text. Only a
 * marker still whole in the text attaches its image, so deleting a marker drops its image.
 */
export class PromptImages {
	readonly #images = new Map<number, PreparedImage>();
	/** Images of a prompt on its way to the core: kept until it is acknowledged, for a draft that comes back. */
	readonly #sending = new Set<number>();
	#next = 1;

	/** The markers of `text` that have an image. */
	#held(text: string): number[] {
		const ids = [...text.matchAll(MARKER)].map((match) => Number(match[1]));
		return [...new Set(ids)].filter((id) => this.#images.has(id));
	}

	/** Keeps `batch` and answers the markers that stand for it, if `text` and the batch stay within the limits. */
	add(text: string, batch: PreparedImage[]): string {
		const live = new Set([...this.#held(text), ...this.#sending]);
		for (const id of this.#images.keys()) if (!live.has(id)) this.#images.delete(id);
		const held = this.#held(text).map((id) => this.#images.get(id) as PreparedImage);
		this.#check([...held, ...batch].map(({ image }) => image));
		return batch
			.map((image) => {
				this.#images.set(this.#next, image);
				return `[Image #${this.#next++}]`;
			})
			.join(" ");
	}

	/** Admission and retry use the same budget, including a refused snapshot merged with a newer draft. */
	#check(images: PreparedImage["image"][]): void {
		if (images.length > MAX_PROMPT_IMAGES) throw new Error(`A prompt accepts at most ${MAX_PROMPT_IMAGES} images.`);
		const bytes = images.reduce((sum, image) => sum + Buffer.byteLength(image.data, "base64"), 0);
		if (bytes > MAX_PROMPT_IMAGE_BYTES) throw new Error("Pasted images exceed the 20 MiB prompt limit.");
	}

	/** The draft's images, if its text holds any marker; they count as sent until `release` or `keep`. */
	attach(text: string): ImageDraft | undefined {
		const ids = this.#held(text);
		if (ids.length === 0) return undefined;
		const images = ids.map((id) => (this.#images.get(id) as PreparedImage).image);
		this.#check(images);
		for (const id of ids) this.#sending.add(id);
		const textOnly = text.replace(MARKER, (marker, id) => (this.#images.has(Number(id)) ? "" : marker));
		return { prompt: textOnly.trim() === "" ? "" : textOnly, ids, images };
	}

	/** Whether `text` holds an image marker. */
	has(text: string): boolean {
		return this.#held(text).length > 0;
	}

	/** The core took the draft. */
	release(draft: ImageDraft): void {
		for (const id of draft.ids) {
			this.#sending.delete(id);
			this.#images.delete(id);
		}
	}

	/** The core did not take the draft; its text comes back to the editor, and its images stay. */
	keep(draft: ImageDraft): void {
		for (const id of draft.ids) this.#sending.delete(id);
	}

	/** A new session starts with no images. */
	reset(): void {
		this.#images.clear();
		this.#sending.clear();
		this.#next = 1;
	}
}
