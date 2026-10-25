import { expect, it } from "vitest";
import { findDestructiveCommand } from "../src/tools/destructive-guard.ts";

const context = { cwd: "/work/project", home: "/home/person" };
const join = (words: string[]) => words.join(" ");
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const root = "recursive removal of /";
const project = "recursive removal of the project directory";
const home = "recursive removal of the home directory";

for (const [target, rule] of [
	["/", root],
	[".", project],
	[context.home, home],
]) {
	it(`refuses removal of ${target} after a single-quoted literal escape`, () => {
		const payload = join(["rm", "-rf", "'entry\\c'", target!]);
		expect(findDestructiveCommand(join(["env", "-S", quote(payload)]), context)).toBe(rule);
	});
}
// Fail closed: the guard never stops reading at `\c`, so what follows it is judged as well.
it("refuses destructive-looking arguments after an unquoted truncation", () => {
	const payload = join(["echo", "\\c", "rm", "-rf", "/"]);
	expect(findDestructiveCommand(join(["env", "-S", quote(payload)]), context)).toBe(root);
});
it("retains outer arguments after truncating the split string", () => {
	const payload = join(["rm", "-rf", "\\c", "node"]);
	expect(findDestructiveCommand(join(["env", "-S", quote(payload), "/"]), context)).toBe(root);
});
for (const options of [["-i"], ["-u", "VAR"], ["-iu", "VAR"]]) {
	it(`recognizes split options ${join(options)}`, () => {
		const payload = join([...options, "rm", "-rf", "/"]);
		expect(findDestructiveCommand(join(["env", "-S", quote(payload)]), context)).toBe(root);
	});
}
for (const pattern of ["[*]", "[a-z]*", "[?*]"]) {
	it(`allows the narrowing name pattern ${pattern}`, () => {
		expect(findDestructiveCommand(join(["find", ".", "-name", quote(pattern), "-delete"]), context)).toBeUndefined();
	});
}
it("allows a regex that excludes slash-containing paths", () => {
	expect(findDestructiveCommand(join(["find", ".", "-regex", quote("[^/]*"), "-delete"]), context)).toBeUndefined();
});
