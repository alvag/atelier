import { common, createLowlight } from "lowlight";
import type { Paint, Style } from "./style.ts";

const lowlight = createLowlight(common);

type Node = ReturnType<typeof lowlight.highlight>["children"][number];
type Element = Extract<Node, { type: "element" }>;

/** The style of each highlight.js token class; a class not listed keeps the color of the token around it. */
const tokenStyles: Record<string, Style> = {
	keyword: "magenta",
	literal: "magenta",
	built_in: "magenta",
	string: "green",
	regexp: "green",
	symbol: "green",
	addition: "green",
	number: "yellow",
	comment: "dim",
	quote: "dim",
	meta: "dim",
	title: "blue",
	type: "cyan",
	attr: "cyan",
	attribute: "cyan",
	property: "cyan",
	name: "cyan",
	tag: "cyan",
	"selector-tag": "cyan",
	"selector-id": "cyan",
	"selector-class": "cyan",
	variable: "cyan",
	deletion: "red",
	emphasis: "italic",
	strong: "bold",
};

function styleOf(element: Element, outer: Style | undefined): Style | undefined {
	const classes = element.properties.className;
	if (!Array.isArray(classes)) return outer;
	for (const name of classes) {
		const style = tokenStyles[String(name).replace(/^hljs-/, "")];
		if (style) return style;
	}
	return outer;
}

/**
 * The lines of a code block with its tokens colored, for a language highlight.js knows; any other block comes back
 * as plain lines. Each line is painted on its own, so a token that spans lines never colors the next one.
 */
export function highlightCode(paint: Paint, code: string, lang?: string): string[] {
	if (!lang || !lowlight.registered(lang)) return code.split("\n");
	const lines = [""];
	const walk = (nodes: Node[], style: Style | undefined) => {
		for (const node of nodes) {
			if (node.type === "element") walk(node.children, styleOf(node, style));
			else if (node.type === "text") {
				node.value.split("\n").forEach((piece, i) => {
					if (i > 0) lines.push("");
					if (piece) lines[lines.length - 1] += style ? paint(style, piece) : piece;
				});
			}
		}
	};
	walk(lowlight.highlight(lang, code).children, undefined);
	return lines;
}
