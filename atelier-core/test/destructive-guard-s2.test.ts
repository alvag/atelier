import { expect, it } from "vitest";
import { findDestructiveCommand } from "../src/tools/destructive-guard.ts";

const context = { cwd: "/work/project", home: "/home/person" };
const join = (words: string[]) => words.join(" ");
const root = "recursive removal of /";
const home = "recursive removal of the home directory";
const project = "recursive removal of the project directory";

// S2 / 25348d1: these expressions do not narrow the removal.
const expressions = [
	["-print", "-delete"],
	["-true", "-delete"],
	["-print0", "-delete"],
	["-delete", ">out"],
	["-exec", "echo", "{}", "\\;", "-delete"],
	["-name", "'*'", "-delete"],
	["\\(", "-delete", "\\)"],
	["-depth", "-a", "-delete"],
];
for (const [path, rule] of [
	["/", root],
	["$HOME", home],
	[".", project],
]) {
	for (const expression of expressions) {
		const command = join(["find", path!, ...expression]);
		it(`S2 refuses ${command}`, () => {
			expect(findDestructiveCommand(command, context)).toBe(rule);
		});
	}
}

// S2 / 3e1c798: retain the executable behind redirections and all env argv.
const wrapped = [
	["2>&1", "rm", "-rf", "/"],
	["2>&", "1", "rm", "-rf", "/"],
	["{fd}>file", "rm", "-rf", "/"],
	[">|out", "rm", "-rf", "/"],
	["env", "2>&1", "rm", "-rf", "/"],
	["env", "-S", "rm", "-rf", "/"],
	["env", "-S", "'rm -rf'", "/"],
	["env", "--split-string='rm -rf'", "/"],
	["env", "-iS", JSON.stringify(join(["rm", "-rf", "/"]))],
	["env", "-vS", JSON.stringify(join(["rm", "-rf", "/"]))],
];
for (const words of wrapped) {
	const command = join(words);
	it(`S2 refuses ${command}`, () => {
		expect(findDestructiveCommand(command, context)).toBe(root);
	});
}
for (const [path, rule] of [
	['"$HOME"', home],
	["/work/project", project],
]) {
	const command = join(["env", "-S", "rm", "-rf", path!]);
	it(`S2 preserves the existing refusal for ${command}`, () => {
		expect(findDestructiveCommand(command, context)).toBe(rule);
	});
}

// S2 / 3e1c798: env splits arguments; it does not interpret shell operators.
const ordinary = [
	["env", "-S", "'echo hi; sudo x'"],
	["env", "-S", "'echo hi | sudo x'"],
	["env", "-S", "'echo hi && sudo x'"],
	["env", "-S", "'echo hi; find / -delete'"],
	["env", "-S", "'node script.js'"],
	[">out.txt", "echo", "hi"],
	["find", "node_modules", "-delete"],
	["find", ".", "-name", "'*.log'", "-delete"],
];
for (const words of ordinary) {
	const command = join(words);
	it(`S2 allows ${command}`, () => {
		expect(findDestructiveCommand(command, context)).toBeUndefined();
	});
}

// S3: the rest of the round-two cases (env option variants, find wrappers and exec forms).
const rm = join(["rm", "-rf", "{}"]);
const refusedMore: [string, string][] = [
	[join(["env", "-i", "-S", "'rm -rf'", "/"]), root],
	[join(["env", "-u", "VAR", "-S", "'rm -rf'", "/"]), root],
	[join(["env", "VAR=x", "-S", "'rm -rf'", "/"]), root],
	[join(["env", "-S", "'sh -c'", JSON.stringify(join(["rm", "-rf", "/"]))]), root],
	[join(["env", "-S", "'sudo'", "ls"]), "sudo"],
	[join(["env", "2>&1", "sudo", "ls"]), "sudo"],
	[join(["find", "/", "-exec", "env", rm, "+"]), root],
	[join(["find", "/", "-exec", "command", rm, "\\;"]), root],
	[join(["find", ".", "-execdir", "env", rm, "+"]), project],
	[join(["find", ".", "-type", "d", "-exec", rm, "+"]), project],
	[join(["find", ".", "-ok", "rm", "{}", "\\;"]), project],
	[join(["find", "/", "-okdir", "rm", "{}", "\\;"]), root],
	[join(["gfind", "/", "-delete"]), root],
	[join(["builtin", "exec", "find", "/", "-delete"]), root],
	[join(["command", "find", "~", "-delete"]), home],
	[join(["sudo", "find", "/", "-delete"]), "sudo"],
	[join(["find", ".", "-mtime", "+30", "-delete"]), project],
	[join(["find", ".", "-name", "'*'", "-exec", "rm", "{}", "+"]), project],
	[join(["find", ".", "!", "-name", "'*.keep'", "-delete"]), project],
	[join(["find", ".", "-exec", "echo", "-name", "x", "\\;", "-delete"]), project],
];
for (const [command, rule] of refusedMore) {
	it(`S3 refuses ${command}`, () => {
		expect(findDestructiveCommand(command, context)).toBe(rule);
	});
}

const allowedMore = [
	join(["find", ".", "-name", "'*.tmp'", "-delete"]),
	join(["find", "src", "-delete"]),
	join(["find", ".", "-path", "'./build/*'", "-delete"]),
	join(["find", "/tmp/x", "-delete"]),
	join(["find", "/", "-iname", "'*.bak'", "-exec", "rm", "{}", "+"]),
	join(["find", ".", "-regex", "'.*\\.o'", "-delete"]),
	join(["find", ".", "-type", "f", "-name", "x", "-exec", "env", rm, "+"]),
	join(["find", ".", "-print"]),
	join(["env", "2>&1", "echo", "hi"]),
	join(["env", "-iS", JSON.stringify("echo hi; sudo x")]),
	join(["echo", "hi", "2>&1"]),
];
for (const command of allowedMore) {
	it(`S3 allows ${command}`, () => {
		expect(findDestructiveCommand(command, context)).toBeUndefined();
	});
}
