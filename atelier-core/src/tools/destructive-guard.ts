import { resolve } from "node:path";

/**
 * The commands `bash` refuses always, before the sandbox and before any
 * approval, even with `--yes`. It follows gentle-shell's destructive command
 * guard: recognizable executable forms only. It is deliberately not a shell
 * interpreter and not the sandbox: it does not expand variables beyond `~`,
 * `$HOME` and `$PWD`, does not load scripts, and does not read pipes
 * (`echo / | xargs rm -rf`), `bash <<EOF` heredocs or files. A command it does
 * not recognize is not refused here; the sandbox is the next layer.
 */

export interface GuardContext {
	/** The project root: the working directory of the command. */
	cwd: string;
	home: string;
}

interface Token {
	value: string;
	raw: string;
	operator: boolean;
	index: number;
}

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);
const MAX_DEPTH = 4;

/** Literal, named heredocs are data, not commands; offsets are preserved. */
function blankHeredocs(command: string): string {
	return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (raw) => {
		const headerLength = raw.indexOf("\n") + 1;
		return raw.slice(0, headerLength) + " ".repeat(raw.length - headerLength);
	});
}

/** Words and operators; quoted text stays inside its word, so prose is never taken for a command. */
function tokenize(command: string): Token[] {
	const pattern = /(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s;&|()'"\\])+|&&|\|\||[;&|()\n]/g;
	return [...command.matchAll(pattern)].map((match) => {
		const raw = match[0];
		const value = raw.replace(
			/"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g,
			(_raw, double: string | undefined, single: string | undefined, escaped: string | undefined) => {
				if (double !== undefined)
					return double.replace(/\\(["\\$`\n])/g, (_escape, char: string) => (char === "\n" ? "" : char));
				return single ?? escaped ?? "";
			},
		);
		return { value, raw, operator: SEPARATORS.has(raw), index: match.index };
	});
}

const executable = (value: string) => value.split("/").at(-1) ?? value;

const WRAPPERS = ["env", "sudo", "command", "exec", "nohup", "timeout", "xargs", "nice", "time", "setsid"];
const WRAPPER_VALUE_OPTIONS: Record<string, readonly string[]> = {
	env: ["-u", "--unset", "-C", "--chdir"],
	sudo: ["-u", "-g", "-h", "-p", "-C", "--user", "--group", "--host", "--prompt", "--chdir"],
	timeout: ["-s", "--signal", "-k", "--kill-after"],
	xargs: ["-n", "-I", "-P", "--max-args", "--replace", "--max-procs"],
	nice: ["-n"],
};
/** Unquoted words after which a command follows. */
const RESERVED_WORDS = new Set(["then", "else", "elif", "do", "{", "!", "if", "while", "until"]);

/** Where the real command starts in a segment, and the wrappers (`env`, `sudo`, ...) passed on the way. */
function head(segment: readonly Token[]): { cursor: number; wrappers: string[] } {
	const wrappers: string[] = [];
	let cursor = 0;
	while (
		cursor < segment.length &&
		segment[cursor]?.raw === segment[cursor]?.value &&
		RESERVED_WORDS.has(segment[cursor]?.value ?? "")
	)
		cursor++;
	while (cursor < segment.length) {
		const value = segment[cursor]?.value ?? "";
		if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(value)) {
			cursor++;
			continue;
		}
		const name = executable(value);
		if (!WRAPPERS.includes(name)) break;
		wrappers.push(name);
		cursor++;
		while (cursor < segment.length && segment[cursor]?.value.startsWith("-")) {
			const flag = segment[cursor++]?.value ?? "";
			if (flag === "--") break;
			if (WRAPPER_VALUE_OPTIONS[name]?.includes(flag)) cursor++;
		}
		if (name === "timeout") cursor++;
	}
	return { cursor, wrappers };
}

/**
 * Bodies of `$(...)` and backtick substitutions outside single quotes (also
 * inside double quotes), which run like commands of their own.
 */
function substitutionBodies(command: string): string[] {
	const bodies: string[] = [];
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (quote === "'") {
			if (char === "'") quote = undefined;
		} else if (char === "\\") {
			index++;
		} else if (char === "'" && quote === undefined) {
			quote = "'";
		} else if (char === '"') {
			quote = quote === '"' ? undefined : '"';
		} else if (char === "`") {
			let end = index + 1;
			while (end < command.length && command[end] !== "`") end += command[end] === "\\" ? 2 : 1;
			if (end >= command.length) break;
			bodies.push(command.slice(index + 1, end).replace(/\\([\\$`])/g, "$1"));
			index = end;
		} else if (char === "$" && command[index + 1] === "(") {
			let depth = 1;
			let end = index + 2;
			while (end < command.length && depth > 0) {
				if (command[end] === "(") depth++;
				else if (command[end] === ")") depth--;
				end++;
			}
			if (depth > 0) break;
			bodies.push(command.slice(index + 2, end - 1));
			index += 1;
		}
	}
	return bodies;
}

/** `:(){ :|:& };:` and any function that pipes itself into itself in the background; quoted text is left out. */
function hasForkBomb(command: string): boolean {
	const unquoted = command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, " ").replace(/\s+/g, "");
	return /([^(){}|&;]+)\(\)\{\1\|\1&\};?\1/.test(unquoted);
}

type PathKind = "root" | "home" | "project";

/** What a `rm` or `chmod` operand points at: `/`, the home directory, or the project directory or one above it. */
function pathKind(operand: string, { cwd, home }: GuardContext): PathKind | undefined {
	const expanded = operand
		.replace(/^(?:\$\{HOME\}|\$HOME|~)(?=\/|$)/, home)
		.replace(/^(?:\$\{PWD\}|\$PWD)(?=\/|$)/, cwd)
		.replace(/\/\*$/, "");
	if (/[$*?[\]{}`]/.test(expanded)) return undefined;
	const path = resolve(cwd, expanded === "" ? "/" : expanded);
	if (path === "/") return "root";
	if (path === home) return "home";
	if (path === cwd || cwd.startsWith(`${path}/`)) return "project";
	return undefined;
}

const REMOVAL_RULE: Record<PathKind, string> = {
	root: "recursive removal of /",
	home: "recursive removal of the home directory",
	project: "recursive removal of the project directory",
};

/** Operands that are not options; after `--` everything is one. */
function operands(args: readonly string[]): string[] {
	const found: string[] = [];
	let options = true;
	for (const arg of args) {
		if (options && arg === "--") options = false;
		else if (!options || !arg.startsWith("-")) found.push(arg);
	}
	return found;
}

const RECURSIVE_RM = /^(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/;
const RECURSIVE_CH = /^(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)$/;
/** Devices `dd` may write: they are not storage. */
const HARMLESS_DEVICES = /^\/dev\/(?:null|stdout|stderr|stdin|tty|fd\/\d+)$/;

/** The rule a simple command breaks, given its name and arguments. */
function commandRule(name: string, args: readonly string[], context: GuardContext): string | undefined {
	if (name === "su") return "su";
	if (/^mkfs(?:\..+)?$/.test(name)) return "mkfs";
	if (name === "dd" && args.some((arg) => arg.startsWith("of=/dev/") && !HARMLESS_DEVICES.test(arg.slice(3))))
		return "dd to a device";
	if (name === "rm" && args.some((arg) => RECURSIVE_RM.test(arg))) {
		for (const operand of operands(args)) {
			const kind = pathKind(operand, context);
			if (kind) return REMOVAL_RULE[kind];
		}
	}
	if ((name === "chmod" || name === "chown") && args.some((arg) => RECURSIVE_CH.test(arg)))
		if (operands(args).some((operand) => pathKind(operand, context) === "root")) return "recursive chmod/chown on /";
	return undefined;
}

/** The rule a command breaks, or undefined when the guard does not recognize it as destructive. */
export function findDestructiveCommand(command: string, context: GuardContext, depth = 0): string | undefined {
	if (depth > MAX_DEPTH) return undefined;
	const text = blankHeredocs(command);
	if (hasForkBomb(text)) return "fork bomb";
	const tokens = tokenize(text);
	let start = 0;
	for (let end = 0; end <= tokens.length; end++) {
		if (end < tokens.length && !tokens[end]?.operator) continue;
		const segment = tokens.slice(start, end);
		start = end + 1;
		const { cursor, wrappers } = head(segment);
		if (wrappers.includes("sudo")) return "sudo";
		const first = segment[cursor];
		if (first === undefined) continue;
		const name = executable(first.value);
		const args = segment.slice(cursor + 1).map((token) => token.value);
		const rule = commandRule(name, args, context);
		if (rule) return rule;

		// Commands that run another command line: `sh -c`, `eval`, `find -exec`.
		const nested: string[] = [];
		if (["sh", "bash", "zsh", "dash"].includes(name)) {
			const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
			const payload = flag >= 0 ? args[flag + 1] : undefined;
			if (payload) nested.push(payload);
		}
		if (name === "eval") nested.push((args[0] === "--" ? args.slice(1) : args).join(" "));
		if (name === "find") {
			for (let at = 0; at < args.length; at++) {
				if (args[at] !== "-exec" && args[at] !== "-execdir") continue;
				const rest = args.slice(at + 1);
				const stop = rest.findIndex((arg) => arg === ";" || arg === "+");
				nested.push((stop < 0 ? rest : rest.slice(0, stop)).join(" "));
				if (stop < 0) break;
				at += stop + 1;
			}
		}
		for (const payload of nested) {
			const found = findDestructiveCommand(payload, context, depth + 1);
			if (found) return found;
		}
	}
	for (const body of substitutionBodies(text)) {
		const found = findDestructiveCommand(body, context, depth + 1);
		if (found) return found;
	}
	return undefined;
}
