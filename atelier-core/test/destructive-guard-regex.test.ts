import { describe, expect, it } from "vitest";
import { findDestructiveCommand } from "../src/tools/destructive-guard.ts";

const context = { cwd: "/work/project", home: "/home/person" };
const join = (words: string[]) => words.join(" ");
const quote = (text: string) => `'${text}'`;
const roots = [
	{ root: "/", rule: "recursive removal of /" },
	{ root: "/home/person", rule: "recursive removal of the home directory" },
	{ root: ".", rule: "recursive removal of the project directory" },
];
const regextypes = [[], ["-regextype", "posix-extended"]];

// A regex narrows a deleting find only with a literal character outside classes, quantifiers, anchors, groups and dots.
describe("a find regex without a literal character", () => {
	for (const flag of ["-regex", "-iregex"]) {
		for (const pattern of [".*.*", ".{0,}", "(.*)", ".*|.*", "[^/]*", "[a-z]*", "\\(.*\\)", ".*\\|.*", "\\w*"]) {
			for (const regextype of regextypes) {
				for (const { root, rule } of roots) {
					const command = join(["find", root, ...regextype, flag, quote(pattern), "-delete"]);
					it(`refuses ${command}`, () => {
						expect(findDestructiveCommand(command, context)).toBe(rule);
					});
				}
			}
		}
	}
});

describe("a find regex with a literal character", () => {
	for (const flag of ["-regex", "-iregex"]) {
		for (const pattern of [".*\\.log", ".*/build/.*", "^\\./tmp/.*", "[a-z]*x"]) {
			for (const regextype of regextypes) {
				for (const { root } of roots) {
					const command = join(["find", root, ...regextype, flag, quote(pattern), "-delete"]);
					it(`allows ${command}`, () => {
						expect(findDestructiveCommand(command, context)).toBeUndefined();
					});
				}
			}
		}
	}
});
