// @vitest-environment jsdom
// jsdom, not happy-dom: DOMPurify mis-sanitizes on happy-dom (it kept a <script> in a probe).
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/renderer/src/chat/markdown.ts";

describe("renderMarkdown", () => {
	it("renders Markdown", () => {
		expect(renderMarkdown("# Title\n\nsome **bold** and `code`")).toBe(
			"<h1>Title</h1>\n<p>some <strong>bold</strong> and <code>code</code></p>\n",
		);
	});

	it.each([
		["a script", "<script>alert(1)</script>", /<script/],
		["an image with onerror", '<img src=x onerror="alert(1)">', /<img|onerror/],
		["an inline handler", '<b onclick="x()">b</b>', /onclick/],
		["a javascript: link", '<a href="javascript:alert(1)">x</a>', /javascript:/],
		["a Markdown javascript: link", "[x](javascript:alert(1))", /javascript:/],
		["inline styles", '<p style="position:fixed">x</p>', /style=/],
		["a style tag", "<style>body{display:none}</style>", /<style/],
		["an iframe", '<iframe src="https://example.com"></iframe>', /<iframe/],
	])("strips %s", (_name, input, forbidden) => {
		expect(renderMarkdown(input)).not.toMatch(forbidden);
	});

	it("keeps ordinary https links", () => {
		expect(renderMarkdown("[docs](https://example.com)")).toContain('<a href="https://example.com">docs</a>');
	});

	it("still renders ordinary nesting", () => {
		expect(renderMarkdown("> > quoted\n\n- a\n  - b")).toContain("<blockquote>\n<blockquote>");
	});

	it.each([
		["deeply nested quotes", `${"> ".repeat(60)}<b>deep</b>`],
		["deeply nested lists", `${"- ".repeat(60)}<b>deep</b>`],
		["an enormous text", `**${"x".repeat(300_000)}** <b>huge</b>`],
	])("shows %s as escaped plain text", (_name, input) => {
		const html = renderMarkdown(input);
		expect(html).toMatch(/^<pre class="plain">/);
		expect(html).not.toMatch(/<blockquote|<ul|<strong|<b>/);
		expect(html).toContain("&lt;b&gt;");
	});
});
