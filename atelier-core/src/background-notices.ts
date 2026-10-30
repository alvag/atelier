/** A notice in two sizes: `short` is given instead of `text` once the notices of one delivery pass their budget. */
export interface BackgroundNotice {
	text: string;
	short?: string;
}

/** The characters one delivery of notices gives at most, the separators and the line of what did not fit included. */
export const NOTICE_BUDGET = 24_000;
const SEPARATOR = "\n\n";

/** The line that ends a delivery some notices did not fit in; their jobs and tasks are still listed. */
function leftOutLine(count: number): string {
	return `${count} more notice${count === 1 ? "" : "s"} did not fit: job_list lists the jobs and tasks that ended.`;
}

/** The longest leftOutLine can be, with its separator: kept free until the last notice is in. */
const LEFT_OUT_ROOM = SEPARATOR.length + leftOutLine(1000).length;

/**
 * The notices of one delivery, oldest first, within NOTICE_BUDGET: each whole while it fits, else its short form when
 * that fits; from the first that fits in neither, a line says how many were left out.
 */
export function deliveryText(notices: readonly BackgroundNotice[]): string {
	const parts: string[] = [];
	let used = 0;
	for (const [index, notice] of notices.entries()) {
		const separator = parts.length === 0 ? 0 : SEPARATOR.length;
		const last = index === notices.length - 1;
		const room = NOTICE_BUDGET - used - separator - (last ? 0 : LEFT_OUT_ROOM);
		const text =
			notice.text.length <= room
				? notice.text
				: notice.short !== undefined && notice.short.length <= room
					? notice.short
					: undefined;
		if (text === undefined) {
			parts.push(leftOutLine(notices.length - index));
			break;
		}
		parts.push(text);
		used += separator + text.length;
	}
	return parts.join(SEPARATOR);
}
