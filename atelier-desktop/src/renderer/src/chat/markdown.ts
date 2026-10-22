import DOMPurify from "dompurify";
import { marked } from "marked";

/** Model text as safe HTML: no images, styles, scripts or event handlers. Links are opened outside by the main process. */
export function renderMarkdown(text: string): string {
	const html = marked.parse(text, { async: false, gfm: true, breaks: true });
	return DOMPurify.sanitize(html, { FORBID_TAGS: ["img", "style", "form", "input"], FORBID_ATTR: ["style"] });
}
