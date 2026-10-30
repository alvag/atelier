/**
 * The delegation variants of #124, measured by `scripts/measure-delegation.ts` before one becomes the default.
 * Temporary: the winner's text moves into the prompt or the task tool, and `SessionOptions.delegation` goes away.
 * Each one speaks of an explorer, so it applies only to a session that has one.
 */
export const DELEGATION_VARIANTS = ["baseline", "rule", "why", "notice", "rule+notice"] as const;
export type DelegationVariant = (typeof DELEGATION_VARIANTS)[number];

/** V1: in the ODD rules, after the route line. */
export const BREADTH_RULE =
	"- Before your first read for a question, judge its breadth: if answering needs more than about 3 reads or 10k tokens of code, do not read it yourself; send one explorer with the question and the paths you know, and ask for at most about 2k tokens with path:line evidence. A question you can answer in up to 3 reads stays inline.";

/** V3: in the task tool's rules, after the explorer's. */
export const WHY_DELEGATE =
	"- Each file you read stays in your context and is sent again with every later request of yours; an explorer's reads do not.";

export const withBreadthRule = (variant: DelegationVariant | undefined) =>
	variant === "rule" || variant === "rule+notice";
export const withWhyDelegate = (variant: DelegationVariant | undefined) => variant === "why";
export const withReadNotice = (variant: DelegationVariant | undefined) =>
	variant === "notice" || variant === "rule+notice";

/** V2: the read notice comes once both are reached by the main agent's successful reads of one turn. */
export const NOTICE_CALLS = 5;
export const NOTICE_CHARS = 20_000;

const READS = new Set(["read", "grep"]);
/** After one of these in the turn the notice never comes: the agent delegated or is making a change. */
const ENDS_NOTICE = new Set(["task", "edit", "write"]);

/** What the main agent is told with the result of the read that reached the threshold. */
export function readNotice(reads: number, chars: number): string {
	return `You have read ${reads} times in this turn, about ${Math.round(chars / 4000)}k tokens, past the task tool's limit for reading inline. For what is left, send one explorer with the question and the paths you already know, and ask for at most about 2k tokens with path:line evidence, instead of reading on yourself.`;
}

/** The main agent's reads in one turn, told once when they pass the threshold; characters stand for tokens, 4 to 1. */
export class InlineReads {
	#reads = 0;
	#chars = 0;
	#done = false;

	/** The notice for the call that just ended with an output of `chars` characters; undefined for every other call. */
	after(tool: string, ok: boolean, chars: number): string | undefined {
		if (this.#done) return undefined;
		if (ENDS_NOTICE.has(tool)) {
			this.#done = true;
			return undefined;
		}
		if (!ok || !READS.has(tool)) return undefined;
		this.#reads++;
		this.#chars += chars;
		if (this.#reads < NOTICE_CALLS || this.#chars < NOTICE_CHARS) return undefined;
		this.#done = true;
		return readNotice(this.#reads, this.#chars);
	}
}
