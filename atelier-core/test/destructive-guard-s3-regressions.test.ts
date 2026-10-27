import { expect, it } from "vitest";
import { findDestructiveCommand } from "../src/tools/destructive-guard.ts";

const context = { cwd: "/work/project", home: "/home/person" };
const join = (words: string[]) => words.join(" ");
const quote = (text: string) => `'${text}'`;
const project = "recursive removal of the project directory";
const root = "recursive removal of /";
const home = "recursive removal of the home directory";

// A negation anywhere in the expression voids the narrowing, groups included.
for (const negation of ["!", "-not"]) {
	it(`rejects a ${negation} group around a narrowing test`, () => {
		const words = ["find", ".", negation, "\\(", "-name", quote("*.keep"), "\\)", "-delete"];
		expect(findDestructiveCommand(join(words), context)).toBe(project);
	});
	it(`rejects a ${negation} around nested groups`, () => {
		const words = ["find", ".", negation, "\\(", "\\(", "-name", quote("*.keep"), "\\)", "\\)", "-delete"];
		expect(findDestructiveCommand(join(words), context)).toBe(project);
	});
}

// env -S honors the GNU escapes when it splits.
for (const separator of ["\\_", "\\t", "\\n", "\\v", "\\f"]) {
	it(`recognizes env splitting with ${separator}`, () => {
		const payload = ["rm", "-rf", "."].join(separator);
		expect(findDestructiveCommand(join(["env", "-S", quote(payload)]), context)).toBe(project);
	});
}
it("keeps an escaped backslash or quote inside its word", () => {
	const payload = join(["echo", "a\\\\b", "\\$x", "\\#y", '\\"z']);
	expect(findDestructiveCommand(join(["env", "-S", quote(payload)]), context)).toBeUndefined();
});
it("continues env option processing after splitting", () => {
	const payload = join(["-i", "rm", "-rf", "."]);
	expect(findDestructiveCommand(join(["env", "-S", quote(payload)]), context)).toBe(project);
});
it("continues env option processing with a value option after splitting", () => {
	const payload = join(["-u", "VAR", "rm", "-rf", "/"]);
	expect(findDestructiveCommand(join(["env", "-S", quote(payload)]), context)).toBe(root);
});
// Fail closed on purpose: the split argv would name a nonexistent `2>&1` executable, but the guard still refuses.
for (const words of [
	["env", "-S", quote(join(["2>&1", "rm", "-rf", "/"]))],
	["env", "-S", JSON.stringify(join(["2>&1", "rm", "-rf", "/"]))],
	["env", "-iS", quote(join(["2>&1", "rm", "-rf", "/"]))],
	["env", `--split-string=${quote(join(["2>&1", "rm", "-rf", "/"]))}`],
]) {
	it(`refuses ${join(words)}`, () => {
		expect(findDestructiveCommand(join(words), context)).toBe(root);
	});
}

// The broadest target wins between the find path and its -exec body.
it("preserves the outer find refusal before checking its execution body", () => {
	const words = ["find", "/", "-exec", "rm", "-rf", "{}", "~", "\\;"];
	expect(findDestructiveCommand(join(words), context)).toBe(root);
});
it("keeps the exec body refusal when it is broader than the find path", () => {
	const words = ["find", ".", "-exec", "rm", "-rf", "/", "\\;"];
	expect(findDestructiveCommand(join(words), context)).toBe(root);
});
it("prefers home over project between find path and exec body", () => {
	const words = ["find", ".", "-exec", "rm", "-rf", "~", "\\;"];
	expect(findDestructiveCommand(join(words), context)).toBe(home);
});

// Patterns that match everything do not narrow.
for (const flag of ["-name", "-iname", "-path", "-ipath", "-wholename"]) {
	for (const pattern of ["*?", "?*", "**", "?", '"*"']) {
		const command = join(["find", ".", flag, pattern, "-delete"]);
		it(`refuses ${command}`, () => {
			expect(findDestructiveCommand(command, context)).toBe(project);
		});
	}
}
for (const flag of ["-regex", "-iregex"]) {
	for (const pattern of [".*", ".+", "^.*$", "^.*", ".*$"]) {
		for (const written of [quote(pattern), JSON.stringify(pattern)]) {
			const command = join(["find", ".", flag, written, "-delete"]);
			it(`refuses ${command}`, () => {
				expect(findDestructiveCommand(command, context)).toBe(project);
			});
		}
	}
}

// A narrowing test only counts before the deleting action.
it("refuses a narrowing test after -delete", () => {
	expect(findDestructiveCommand(join(["find", ".", "-delete", "-name", "x"]), context)).toBe(project);
});
it("refuses a narrowing test after -exec rm", () => {
	const command = join(["find", ".", "-exec", "rm", "-rf", "{}", "+", "-name", "x"]);
	expect(findDestructiveCommand(command, context)).toBe(project);
});

// Real narrowing still passes.
for (const command of [
	join(["find", ".", "-name", quote("*.tmp"), "-delete"]),
	join(["find", ".", "-name", quote("a?c"), "-delete"]),
	join(["find", ".", "-regex", quote(".*\\.log"), "-delete"]),
	join(["find", ".", "-iname", quote("?.bak"), "-exec", "rm", "{}", "+"]),
	join(["find", ".", "-type", "f", "-path", quote("./build/*"), "-delete"]),
]) {
	it(`allows ${command}`, () => {
		expect(findDestructiveCommand(command, context)).toBeUndefined();
	});
}
