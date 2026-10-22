import { type Usage, ZERO_USAGE } from "./events.ts";
import { costOfRequest } from "./pricing.ts";

/**
 * Totals the API requests of one turn. Each request is priced on its own,
 * because a tier depends on that request's prompt size, not on the turn's sum.
 */
export class UsageMeter {
	readonly #model: string;
	#usage: Usage = { ...ZERO_USAGE };
	#requests = 0;
	#costUsd: number | undefined = 0;

	constructor(model: string) {
		this.#model = model;
	}

	add(usage: Usage): void {
		this.#requests += 1;
		this.#usage = {
			input: this.#usage.input + usage.input,
			output: this.#usage.output + usage.output,
			cacheRead: this.#usage.cacheRead + usage.cacheRead,
			cacheWrite: this.#usage.cacheWrite + usage.cacheWrite,
		};
		const cost = costOfRequest(this.#model, usage);
		this.#costUsd = cost === undefined || this.#costUsd === undefined ? undefined : this.#costUsd + cost;
	}

	get usage(): Usage {
		return { ...this.#usage };
	}

	get requests(): number {
		return this.#requests;
	}

	/** Undefined when the model has no price: tokens are still counted, a cost is never invented. */
	get costUsd(): number | undefined {
		return this.#costUsd;
	}
}
