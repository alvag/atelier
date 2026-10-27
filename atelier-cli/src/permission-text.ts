import { visibleText } from "@atelier/core";

/** The rules in force as the CLI and the TUI list them. */
export interface ShownRule {
	scope: string;
	kind: string;
	value: string;
}

export const PERMISSIONS_USAGE = "usage: /permissions | /permissions remove <number>";

/** How a question names the rules an answer would remember: `"open", "npm install"`, or `edits in <folder>`; control characters shown as markers. */
export function ruleText(tool: string | undefined, rules: readonly string[]): string {
	const text =
		tool === "edit" || tool === "write" ? `edits in ${rules.join(", ")}` : rules.map((rule) => `"${rule}"`).join(", ");
	return visibleText(text).text;
}

/** The numbered list `/permissions` prints, one rule a line. */
export function rulesListing(rules: readonly ShownRule[]): string {
	if (rules.length === 0) return "No permission rules.";
	return rules
		.map(
			({ scope, kind, value }, index) =>
				`${index + 1}. ${scope.padEnd(7)} ${kind.padEnd(5)} ${visibleText(value).text}`,
		)
		.join("\n");
}

/** What `/permissions remove` says it removed. */
export const removedText = ({ scope, kind, value }: ShownRule) =>
	`removed: ${scope} ${kind} ${visibleText(value).text}`;

/** `/permissions` is a list, `/permissions remove <n>` the n-th rule (1-based); anything else is a usage error. */
export function parsePermissions(words: readonly string[]): { remove?: number } | undefined {
	const [action, number, ...extra] = words;
	if (action === undefined) return {};
	if (action !== "remove" || number === undefined || !/^\d+$/.test(number) || extra.length > 0) return undefined;
	return { remove: Number(number) };
}
