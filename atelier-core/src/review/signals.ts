/** Added content that makes a change high risk, wherever it appears; tests included. */
export const CONTENT_SIGNALS: readonly (readonly [RegExp, string])[] = [
	[/\bchild_process\b/, "child_process"],
	[/\bexec(Sync|File|FileSync)?\s*\(/, "exec"],
	[/\beval\s*\(/, "eval"],
	[/\brm\s+-(?=[a-z]*r)(?=[a-z]*f)[a-z]+\b/i, "rm -rf"],
	[/\bdrop\s+table\b/i, "DROP TABLE"],
	[/\bdelete\s+from\b/i, "DELETE FROM"],
];

/** The labels of the content signals in one added line. */
export function contentSignals(text: string): string[] {
	return CONTENT_SIGNALS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

/** Files that can be passive: Markdown and text anywhere, and documentation formats or extensionless files under docs/. */
export function isDocumentationPath(path: string): boolean {
	if (/\.(md|txt)$/i.test(path)) return true;
	if (!(path.startsWith("docs/") || path.includes("/docs/"))) return false;
	const name = path.split("/").pop() ?? path;
	return /\.(md|mdx|txt|rst|adoc)$/i.test(name) || !name.includes(".");
}

/** A Markdown code fence line: ``` or ~~~, indented or not. */
export const FENCE = /^[ \t]*(```|~~~)/m;
