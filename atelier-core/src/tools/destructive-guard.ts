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

/** A redirection operator with its optional descriptor (`2>`, `{fd}>`, `>|`, `2>&1`, `&>`); the file is the next word. */
const REDIRECTION_OPERATOR = /(?:\d+|\{[A-Za-z_]\w*\})?(?:&>>?|[<>]&\d*-?|>>?\|?|<<?|<>)/;
const WORD_OR_OPERATOR = /(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s;&|()'"\\])+|&&|\|\||[;&|()\n]/;

/** Words and operators; quoted text stays inside its word, so prose is never taken for a command. */
function tokenize(command: string): Token[] {
	const pattern = new RegExp(`${REDIRECTION_OPERATOR.source}|${WORD_OR_OPERATOR.source}`, "g");
	return [...command.matchAll(pattern)].map((match) => {
		const raw = match[0];
		return { value: unquote(raw), raw, operator: SEPARATORS.has(raw), index: match.index };
	});
}

/** The text a shell word stands for, without its quotes and escapes. */
function unquote(raw: string): string {
	return raw.replace(
		/"((?:\\.|[^"\\])*)"|'([^']*)'|\\(.)/g,
		(_raw, double: string | undefined, single: string | undefined, escaped: string | undefined) => {
			if (double !== undefined)
				return double.replace(/\\(["\\$`\n])/g, (_escape, char: string) => (char === "\n" ? "" : char));
			return single ?? escaped ?? "";
		},
	);
}

const SPLIT_SEPARATORS: Record<string, string> = { _: " ", t: "\t", n: "\n", v: "\v", f: "\f" };

/**
 * What `env -S` makes of its string: words split on blanks and on the escapes
 * `\_ \t \n \v \f`, quotes respected, `\c` ends the string, no shell operators.
 */
function splitWords(text: string): Token[] {
	const words: string[] = [];
	let word: string | undefined;
	let quote: "'" | '"' | undefined;
	const end = () => {
		if (word !== undefined) words.push(word);
		word = undefined;
	};
	scan: for (let at = 0; at < text.length; at++) {
		const char = text[at] as string;
		if (char === "\\") {
			const next = text[++at];
			if (next === undefined) break;
			if (next === "c") break scan;
			if (next in SPLIT_SEPARATORS && quote === undefined) end();
			else word = (word ?? "") + (quote === '"' || next in SPLIT_SEPARATORS ? (SPLIT_SEPARATORS[next] ?? next) : next);
		} else if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else word = (word ?? "") + char;
		} else if (char === "'" || char === '"') {
			quote = char;
			word ??= "";
		} else if (/\s/.test(char)) end();
		else word = (word ?? "") + char;
	}
	end();
	return words.map((value, index) => ({ value, raw: value, operator: false, index }));
}

const executable = (value: string) => value.split("/").at(-1) ?? value;

const WRAPPERS = ["env", "sudo", "command", "exec", "nohup", "timeout", "xargs", "nice", "time", "setsid", "builtin"];
const WRAPPER_VALUE_OPTIONS: Record<string, readonly string[]> = {
	sudo: ["-u", "-g", "-h", "-p", "-C", "--user", "--group", "--host", "--prompt", "--chdir"],
	timeout: ["-s", "--signal", "-k", "--kill-after"],
	xargs: ["-n", "-I", "-P", "--max-args", "--replace", "--max-procs"],
	nice: ["-n"],
};
/** Unquoted words after which a command follows. */
const RESERVED_WORDS = new Set(["then", "else", "elif", "do", "{", "!", "if", "while", "until"]);

/** A redirection word (`2>file`, `>file`, `<in`, `>>log`, `>|f`); `withTarget` when the file is the next word (`2> file`). */
const REDIRECTION = new RegExp(`^${REDIRECTION_OPERATOR.source}`);
const BARE_REDIRECTION = /^(?:\d+|\{[A-Za-z_]\w*\})?(?:&>>?|>>?\|?|<<?|<>|[<>]&)$/;

/** `env` options that take a value; in a combined cluster (`-iu VAR`) the first one ends the cluster. */
const ENV_VALUE_FLAGS = "uCP";

/**
 * Where the real command starts in a segment, the wrappers (`env`, `sudo`, ...)
 * passed on the way, and the segment itself: `env -S "cmd args" more` runs the
 * words of the string followed by the rest, so the segment returned replaces
 * the string with its words. Redirections before the command or between
 * wrappers are skipped: they never name the command.
 */
function head(segment: readonly Token[]): { segment: readonly Token[]; cursor: number; wrappers: string[] } {
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
		const raw = segment[cursor]?.raw ?? "";
		if (REDIRECTION.test(raw)) {
			cursor += BARE_REDIRECTION.test(raw) ? 2 : 1;
			continue;
		}
		const name = executable(value);
		if (!WRAPPERS.includes(name)) break;
		wrappers.push(name);
		cursor++;
		while (cursor < segment.length) {
			const word = segment[cursor]?.raw ?? "";
			if (REDIRECTION.test(word)) {
				cursor += BARE_REDIRECTION.test(word) ? 2 : 1;
				continue;
			}
			if (name === "env" && /^[A-Za-z_][A-Za-z_0-9]*=/.test(segment[cursor]?.value ?? "")) {
				cursor++;
				continue;
			}
			if (!segment[cursor]?.value.startsWith("-")) break;
			const flag = segment[cursor++]?.value ?? "";
			if (flag === "--") break;
			if (name === "env") {
				const split = envSplitString(flag, segment[cursor]?.value);
				if (split) {
					if (split.takesNext) cursor++;
					// `env -S` splits the string into words, which env then reads as its own arguments: options first, then one command.
					const env: Token = { value: "env", raw: "env", operator: false, index: 0 };
					const inner = head([env, ...splitWords(split.text), ...segment.slice(cursor)]);
					return { ...inner, wrappers: [...wrappers, ...inner.wrappers] };
				}
				if (envValueFlag(flag)) cursor++;
				continue;
			}
			if (WRAPPER_VALUE_OPTIONS[name]?.includes(flag)) cursor++;
		}
		if (name === "timeout") cursor++;
	}
	return { segment, cursor, wrappers };
}

/** The string of `env -S`, `--split-string`, `--split-string=...` or a cluster such as `-iS`/`-vSstring`, and whether it is the next word. */
function envSplitString(flag: string, next: string | undefined): { text: string; takesNext: boolean } | undefined {
	if (flag === "--split-string") return { text: next ?? "", takesNext: true };
	if (flag.startsWith("--split-string=")) return { text: flag.slice("--split-string=".length), takesNext: false };
	if (flag.startsWith("--") || !flag.startsWith("-")) return undefined;
	for (let at = 1; at < flag.length; at++) {
		const char = flag[at] as string;
		if (char === "S") {
			const rest = flag.slice(at + 1);
			return rest === "" ? { text: next ?? "", takesNext: true } : { text: rest, takesNext: false };
		}
		if (ENV_VALUE_FLAGS.includes(char)) return undefined;
	}
	return undefined;
}

/** Whether an `env` option takes the next word as its value: `-u VAR`, `-C dir`, `--unset VAR`, a cluster ending in one. */
function envValueFlag(flag: string): boolean {
	if (flag === "--unset" || flag === "--chdir") return true;
	if (flag.startsWith("--") || !flag.startsWith("-")) return false;
	for (let at = 1; at < flag.length; at++)
		if (ENV_VALUE_FLAGS.includes(flag[at] as string)) return at === flag.length - 1;
	return false;
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

const FIND_NAMES = ["find", "gfind"];
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** `find` tests that choose files by name; with a pattern that is not just `*` they narrow what is removed. */
const FIND_NARROWING = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-regex", "-iregex"]);

/** A pattern that selects every file: only `*` and `?` for the glob tests, `.*`-style for the regex ones. */
function matchesEverything(test: string, pattern: string): boolean {
	if (test.endsWith("regex")) return /^\^?\.[*+]\$?$/.test(pattern);
	return /^[*?]+$/.test(pattern);
}

/** The words of a `-exec` command up to its `;` or `+`, and the index of the terminator (or the end). */
function execCommand(args: readonly string[], from: number): { words: string[]; end: number } {
	const rest = args.slice(from);
	const stop = rest.findIndex((item) => item === ";" || item === "+");
	return stop < 0 ? { words: rest, end: args.length } : { words: rest.slice(0, stop), end: from + stop };
}

/** Whether a `-exec` command runs `rm` once wrappers such as `env` and `command` are stripped. */
function runsRm(words: readonly string[]): boolean {
	const tokens = words.map((value, index) => ({ value, raw: value, operator: false, index }));
	const { segment, cursor } = head(tokens);
	return executable(segment[cursor]?.value ?? "") === "rm";
}

/**
 * A `find` that deletes from `/`, the home directory or the project: a starting
 * point of that kind and `-delete` or an `-exec`/`-execdir`/`-ok`/`-okdir` that
 * runs `rm`. It fails closed: only a `-name`, `-path` or `-regex` style test
 * with a pattern that does not match everything narrows it (`find . -name '*.log' -delete` is
 * fine) and only before the deleting action; `-print`, `-type`, `-mtime`,
 * parentheses, `!`, `-not`, `-o` and the like do not.
 */
function findRemovalKind(args: readonly string[], context: GuardContext): PathKind | undefined {
	let at = 0;
	while (at < args.length && /^-[HLPEXsx]+$/.test(args[at] ?? "")) at++;
	const roots: string[] = [];
	while (at < args.length && !/^[-(!]/.test(args[at] ?? "")) roots.push(args[at++] as string);
	if (roots.length === 0) roots.push(".");
	let removes = false;
	let narrowed = false;
	let either = false;
	let negated = false;
	for (; at < args.length; at++) {
		const arg = args[at] as string;
		if (arg === "-o" || arg === "-or" || arg === ",") either = true;
		else if (arg === "!" || arg === "-not") negated = true;
		else if (arg === "-delete") removes = true;
		else if (FIND_EXEC.has(arg)) {
			const { words, end } = execCommand(args, at + 1);
			if (runsRm(words)) removes = true;
			at = end;
		} else if (FIND_NARROWING.has(arg)) {
			// Only a test before the deleting action selects what it deletes.
			if (!removes && !matchesEverything(arg, args[at + 1] ?? "*")) narrowed = true;
			at++;
		}
	}
	if (!removes || (narrowed && !either && !negated)) return undefined;
	for (const root of roots) {
		const kind = pathKind(root, context);
		if (kind) return kind;
	}
	return undefined;
}

/** The first rule, or the broadest removal when several removals apply (`/`, then home, then project). */
function broadest(rules: readonly string[]): string {
	const order = [REMOVAL_RULE.root, REMOVAL_RULE.home, REMOVAL_RULE.project];
	const rank = (rule: string) => (order.includes(rule) ? order.indexOf(rule) : -1);
	return rules.reduce((best, rule) => (rank(rule) > -1 && rank(best) > -1 && rank(rule) < rank(best) ? rule : best));
}

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
	if (FIND_NAMES.includes(name)) {
		const kind = findRemovalKind(args, context);
		if (kind) return REMOVAL_RULE[kind];
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
		const { segment, cursor, wrappers } = head(tokens.slice(start, end));
		start = end + 1;
		if (wrappers.includes("sudo")) return "sudo";
		const first = segment[cursor];
		if (first === undefined) continue;
		const name = executable(first.value);
		const args = segment.slice(cursor + 1).map((token) => token.value);
		// Commands that run another command line: `sh -c`, `eval`, `find -exec`.
		const nested: string[] = [];
		if (["sh", "bash", "zsh", "dash"].includes(name)) {
			const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
			const payload = flag >= 0 ? args[flag + 1] : undefined;
			if (payload) nested.push(payload);
		}
		if (name === "eval") nested.push((args[0] === "--" ? args.slice(1) : args).join(" "));
		if (FIND_NAMES.includes(name)) {
			for (let at = 0; at < args.length; at++) {
				if (!FIND_EXEC.has(args[at] ?? "")) continue;
				const rest = args.slice(at + 1);
				const stop = rest.findIndex((arg) => arg === ";" || arg === "+");
				nested.push((stop < 0 ? rest : rest.slice(0, stop)).join(" "));
				if (stop < 0) break;
				at += stop + 1;
			}
		}
		// The broadest removal wins between a command and the command lines it runs.
		const found: string[] = [];
		for (const payload of nested) {
			const rule = findDestructiveCommand(payload, context, depth + 1);
			if (rule) found.push(rule);
		}
		const own = commandRule(name, args, context);
		if (own) found.push(own);
		if (found.length > 0) return broadest(found);
	}
	for (const body of substitutionBodies(text)) {
		const found = findDestructiveCommand(body, context, depth + 1);
		if (found) return found;
	}
	return undefined;
}
