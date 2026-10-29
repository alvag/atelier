/** The numbers of an id, as its version: `claude-opus-5-5` is 5.5, `glm-5.3-flash` 5.3; a date (`-20251001`) is not one. */
function versionOf(id: string): number[] {
	return (id.match(/\d+/g) ?? []).filter((digits) => digits.length < 8).map(Number);
}

/** Positive when `a` is a newer version than `b`; a longer version is newer when the rest is the same (5.5 over 5). */
function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (a[index] ?? -1) - (b[index] ?? -1);
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * The ids newest first: the ones with a release date by it, then the ones without, by the version in their name.
 * Ties keep the order they came in, so the code's list orders what nothing else does.
 */
export function newestFirst(ids: readonly string[], released: (id: string) => string | undefined): string[] {
	const keyed = ids.map((id) => ({ id, date: released(id), version: versionOf(id) }));
	return keyed
		.sort((a, b) => {
			if (a.date !== undefined && b.date !== undefined) return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
			if (a.date !== undefined || b.date !== undefined) return a.date === undefined ? 1 : -1;
			return compareVersions(b.version, a.version);
		})
		.map(({ id }) => id);
}
