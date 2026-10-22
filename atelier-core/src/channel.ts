/** Unbounded single-consumer queue that can be fed from several producers. */
export class Channel<T> implements AsyncIterable<T> {
	#items: T[] = [];
	#waiter: ((result: IteratorResult<T>) => void) | undefined;
	#closed = false;

	get closed(): boolean {
		return this.#closed;
	}

	push(item: T): void {
		if (this.#closed) return;
		const waiter = this.#waiter;
		if (waiter) {
			this.#waiter = undefined;
			waiter({ value: item, done: false });
		} else {
			this.#items.push(item);
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const waiter = this.#waiter;
		this.#waiter = undefined;
		waiter?.({ value: undefined, done: true });
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.#items.length > 0) {
				yield this.#items.shift() as T;
				continue;
			}
			if (this.#closed) return;
			const next = await new Promise<IteratorResult<T>>((resolve) => {
				this.#waiter = resolve;
			});
			if (next.done) return;
			yield next.value;
		}
	}
}
