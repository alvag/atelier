import DOMPurify from "dompurify";
import { marked } from "marked";

/** Beyond these, marked's lexer can hang the renderer (pi 8a2ebd38), so the text is shown as is. */
const MAX_LENGTH = 200_000;
const MAX_DEPTH = 32;

/** The quote and list markers that open a line, like the three in `> > - item`. */
const CONTAINER_PREFIX = /^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))+/;
const CONTAINER_MARKER = />|[-*+]|\d{1,9}[.)]/g;

function nestingDepth(line: string): number {
	const prefix = CONTAINER_PREFIX.exec(line)?.[0] ?? "";
	return prefix.match(CONTAINER_MARKER)?.length ?? 0;
}

function isPathological(text: string): boolean {
	return text.length > MAX_LENGTH || text.split("\n").some((line) => nestingDepth(line) > MAX_DEPTH);
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Model text as safe HTML: no images, styles, scripts or event handlers. Links are opened outside by the main process. */
export function renderMarkdown(text: string): string {
	if (isPathological(text)) return `<pre class="plain">${escapeHtml(text)}</pre>`;
	const html = marked.parse(text, { async: false, gfm: true, breaks: true });
	return DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "style", "form", "input"], FORBID_ATTR: ["style"] });
}
