/** Unbounded single-consumer queue that can be fed from several producers. */
export class Channel<T> implements AsyncIterable<T> {
	#items: T[] = [];
	#waiter: ((result: IteratorResult<T>) => void) | undefined;
	#closed = false;
	/** The consumer holds an item it has not come back from: the last one taken may still be in use. */
	#holding = false;
	#drainWaiters = new Set<() => void>();

	get closed(): boolean {
		return this.#closed;
	}

	push(item: T): void {
		if (this.#closed) return;
		const waiter = this.#waiter;
		if (waiter) {
			this.#waiter = undefined;
			this.#holding = true;
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
		this.#flush();
	}

	/**
	 * Resolves true once the consumer has taken everything pushed so far and asked for more, so that it has handled it.
	 * Resolves false when the channel closes or `signal` aborts first: nobody may ever read the rest.
	 */
	drained(signal?: AbortSignal): Promise<boolean> {
		if (this.#items.length === 0 && !this.#holding) return Promise.resolve(true);
		if (this.#closed || signal?.aborted) return Promise.resolve(false);
		return new Promise((resolve) => {
			const settle = (delivered: boolean) => {
				this.#drainWaiters.delete(onDrained);
				signal?.removeEventListener("abort", onAbort);
				resolve(delivered);
			};
			const onDrained = () => settle(!this.#closed);
			const onAbort = () => settle(false);
			this.#drainWaiters.add(onDrained);
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	#flush(): void {
		for (const resolve of [...this.#drainWaiters]) resolve();
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			this.#holding = false;
			if (this.#items.length > 0) {
				this.#holding = true;
				yield this.#items.shift() as T;
				continue;
			}
			this.#flush();
			if (this.#closed) return;
			const next = await new Promise<IteratorResult<T>>((resolve) => {
				this.#waiter = resolve;
			});
			if (next.done) return;
			this.#holding = true;
			yield next.value;
		}
	}
}
