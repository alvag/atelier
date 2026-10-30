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
