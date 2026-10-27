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

interface Heredoc {
	/** Where its `<<` is. */
	header: number;
	/** The body, from the line after the header to the terminator line, which ends at `end`. */
	body: number;
	terminator: number;
	end: number;
	/** A quoted delimiter (`<<'EOF'`, `<<"EOF"`, `<<E\OF`) keeps the body literal; otherwise it runs its substitutions. */
	quoted: boolean;
}

interface HeredocHeader {
	header: number;
	tabs: boolean;
	delimiter: string;
	quoted: boolean;
}

/** What the shell reads in a command: its heredocs, and the `\` of every line continuation it removes. */
interface ShellReading {
	heredocs: Heredoc[];
	continuations: number[];
}

/** The characters that end an unquoted shell word. */
const METACHARACTER = /[\s;&|()<>]/;

/** The line of `command` that starts at `at`, and where it ends. */
function lineAt(command: string, at: number): { line: string; end: number } {
	const newline = command.indexOf("\n", at);
	const end = newline < 0 ? command.length : newline;
	return { line: command.slice(at, end), end };
}

/**
 * The delimiter of a heredoc header, from the word that starts at `from`, as the shell builds it: the whole word,
 * without its quotes and backslashes, which make it quoted (`<<'EOF'x` is `EOFx`, `<<E\OF` is `EOF`). Undefined
 * when there is no word or a quote does not close.
 */
function heredocDelimiter(
	command: string,
	from: number,
	continuations: number[],
): { delimiter: string; quoted: boolean; end: number } | undefined {
	let delimiter = "";
	let quoted = false;
	let at = from;
	while (at < command.length && !METACHARACTER.test(command[at] as string)) {
		const char = command[at] as string;
		if (char === "\\") {
			if (command[at + 1] === "\n") continuations.push(at);
			else {
				delimiter += command[at + 1] ?? "";
				quoted = true;
			}
			at += 2;
		} else if (char === "'") {
			const close = command.indexOf("'", at + 1);
			if (close < 0) return undefined;
			delimiter += command.slice(at + 1, close);
			quoted = true;
			at = close + 1;
		} else if (char === '"') {
			quoted = true;
			at++;
			while (command[at] !== '"') {
				if (at >= command.length) return undefined;
				const next = command[at + 1] ?? "";
				if (command[at] === "\\" && next === "\n") at += 2;
				else if (command[at] === "\\" && /["\\$`]/.test(next)) {
					delimiter += next;
					at += 2;
				} else delimiter += command[at++];
			}
			at++;
		} else {
			delimiter += char;
			at++;
		}
	}
	return delimiter === "" && !quoted ? undefined : { delimiter, quoted, end: at };
}

/**
 * Where a heredoc body that starts at `from` ends: at the first line that is its delimiter (leading tabs removed for
 * `<<-`). In an unquoted body a line ending in an unescaped `\` goes on in the next one, as in the shell, and that
 * `\` is a continuation. Undefined when no line ends it.
 */
function heredocEnd(
	command: string,
	from: number,
	{ delimiter, tabs, quoted }: HeredocHeader,
	continuations: number[],
): { terminator: number; end: number } | undefined {
	for (let line = from; line <= command.length; ) {
		let text = "";
		let end = line;
		for (;;) {
			const { line: physical, end: stop } = lineAt(command, end);
			const backslashes = /\\*$/.exec(physical)?.[0].length ?? 0;
			if (quoted || backslashes % 2 === 0 || stop >= command.length) {
				text += physical;
				end = stop;
				break;
			}
			text += physical.slice(0, -1);
			continuations.push(stop - 1);
			end = stop + 1;
		}
		if ((tabs ? text.replace(/^\t+/, "") : text) === delimiter) return { terminator: line, end };
		if (end >= command.length) return undefined;
		line = end + 1;
	}
	return undefined;
}

/**
 * The heredocs and line continuations of a command, as the shell reads them. A heredoc is a `<<` (not `<<<`) outside
 * quotes, comments and `((...))`; the bodies start on the line after the header, one after the other. One with no
 * terminator is not one, and reading stops there: it fails closed. A continuation is a `\` before a newline outside
 * single quotes, comments and quoted heredoc bodies; quotes inside a body are text.
 */
function readShell(command: string): ShellReading {
	const found: Heredoc[] = [];
	const continuations: number[] = [];
	const pending: HeredocHeader[] = [];
	let quote: "'" | '"' | undefined;
	let arithmetic = 0;
	let previous = "";
	for (let at = 0; at < command.length; at++) {
		const char = command[at] as string;
		if (quote === "'") {
			if (char === "'") quote = undefined;
		} else if (char === "\\") {
			if (command[at + 1] === "\n") continuations.push(at);
			else previous = command[at + 1] ?? "";
			at++;
			continue;
		} else if (char === '"') quote = quote === '"' ? undefined : '"';
		else if (quote === undefined) {
			if (char === "'") quote = "'";
			else if (char === "#" && /^$|[\s;&|()]$/.test(previous)) at = lineAt(command, at).end - 1;
			else if (command.startsWith("((", at)) {
				arithmetic++;
				at++;
			} else if (arithmetic > 0 && command.startsWith("))", at)) {
				arithmetic--;
				at++;
			} else if (command.startsWith("<<<", at)) at += 2;
			else if (command.startsWith("<<", at) && arithmetic === 0) {
				const tabs = command[at + 2] === "-";
				let from = at + (tabs ? 3 : 2);
				while (command[from] === " " || command[from] === "\t") from++;
				const word = heredocDelimiter(command, from, continuations);
				if (word) {
					pending.push({ header: at, tabs, delimiter: word.delimiter, quoted: word.quoted });
					at = word.end - 1;
				} else at++;
			} else if (char === "\n" && pending.length > 0) {
				let body = at + 1;
				for (const header of pending.splice(0)) {
					const ends = heredocEnd(command, body, header, continuations);
					if (!ends) return { heredocs: found, continuations };
					found.push({ header: header.header, body, ...ends, quoted: header.quoted });
					body = ends.end + 1;
				}
				at = body - 1;
			}
		}
		previous = command[at] as string;
	}
	return { heredocs: found, continuations };
}

const heredocs = (command: string): Heredoc[] => readShell(command).heredocs;

/** Literal, named heredocs are data, not commands: their bodies and terminators become blanks, offsets preserved. */
function blankHeredocs(command: string): string {
	let text = command;
	for (const { body, end } of heredocs(command)) text = text.slice(0, body) + " ".repeat(end - body) + text.slice(end);
	return text;
}

/** The substitutions an unquoted heredoc body runs, where quotes are text; a quoted body runs nothing. */
function heredocSubstitutions(command: string): string[] {
	return heredocs(command)
		.filter(({ quoted }) => !quoted)
		.flatMap(({ body, terminator }) => substitutionBodies(command.slice(body, terminator), false));
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
 * `\_ \t \n \v \f`, quotes respected, no shell operators. `\c` would end the string, but the
 * guard fails closed and drops it, reading every word.
 */
function splitWords(text: string): Token[] {
	const words: string[] = [];
	let word: string | undefined;
	let quote: "'" | '"' | undefined;
	const end = () => {
		if (word !== undefined) words.push(word);
		word = undefined;
	};
	for (let at = 0; at < text.length; at++) {
		const char = text[at] as string;
		if (char === "\\") {
			const next = text[++at];
			if (next === undefined) break;
			if (next === "c") continue;
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
function head(segment: readonly Token[]): {
	segment: readonly Token[];
	cursor: number;
	wrappers: string[];
	extra: Token[][];
} {
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
					const rest = segment.slice(cursor);
					const inner = head([env, ...splitWords(split.text), ...rest]);
					// What follows a `\c` is judged as a command of its own too, in case env stops there.
					const after = [...split.text.matchAll(/\\c/g)].map((match) => [
						env,
						...splitWords(split.text.slice((match.index ?? 0) + 2)),
						...rest,
					]);
					return { ...inner, wrappers: [...wrappers, ...inner.wrappers], extra: [...inner.extra, ...after] };
				}
				if (envValueFlag(flag)) cursor++;
				continue;
			}
			if (WRAPPER_VALUE_OPTIONS[name]?.includes(flag)) cursor++;
		}
		if (name === "timeout") cursor++;
	}
	return { segment, cursor, wrappers, extra: [] };
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
 * inside double quotes), which run like commands of their own. Without
 * `quotes`, as in a heredoc body, quotes are text and hide nothing.
 */
function substitutionBodies(command: string, quotes = true): string[] {
	const bodies: string[] = [];
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		if (quote === "'") {
			if (char === "'") quote = undefined;
		} else if (char === "\\") {
			index++;
		} else if (quotes && char === "'" && quote === undefined) {
			quote = "'";
		} else if (quotes && char === '"') {
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

/** `-r`, `-R` or a cluster with one, or `--recursive` and its prefixes (`--rec`). */
const isRecursiveRm = (arg: string) => /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(arg) || abbreviates(arg, "--recursive");
/** `-R` or a cluster with it, or `--recursive` and its prefixes; `--re`, which could be `--reference`, fails closed. */
const isRecursiveCh = (arg: string) => /^-[a-zA-Z]*R[a-zA-Z]*$/.test(arg) || abbreviates(arg, "--recursive");
/** Devices `dd` may write: they are not storage. */
const HARMLESS_DEVICES = /^\/dev\/(?:null|stdout|stderr|stdin|tty|fd\/\d+)$/;

const FIND_NAMES = ["find", "gfind"];
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
/** `find` tests that choose files by name; with a pattern that does not match everything they narrow what is removed. */
const FIND_NARROWING = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-regex", "-iregex"]);

/** Regex operators: none of them requires a given character in the path. */
const REGEX_OPERATORS = new Set([".", "*", "+", "?", "^", "$", "(", ")", "|", "{", "}"]);
/**
 * Escapes that are operators rather than a literal: groups, alternatives and
 * intervals in emacs and basic regexes, `\<`, `\>`, `` \` ``, `\'`, and
 * letters or digits (`\w`, `\s`, back references).
 */
const REGEX_ESCAPED_OPERATOR = /^[\p{L}\p{N}(){}|<>'`]$/u;

/** The index just past a bracket class that starts at `from`, or the end when it is not closed. */
function classEnd(pattern: string, from: number): number {
	let at = from + 1;
	if (pattern[at] === "^") at++;
	if (pattern[at] === "]") at++;
	while (at < pattern.length && pattern[at] !== "]") {
		const close =
			pattern[at] === "[" && /[:.=]/.test(pattern[at + 1] ?? "") ? pattern.indexOf(`${pattern[at + 1]}]`, at + 2) : -1;
		at = close < 0 ? at + 1 : close + 2;
	}
	return at + 1;
}

/** Whether what follows `at` makes the item before it optional: `?`, `*` or an interval from 0, escaped or not. */
function optionalAt(pattern: string, at: number): boolean {
	const rest = pattern.slice(at);
	return /^(?:[?*]|\\?\{0)/.test(rest);
}

/**
 * Whether a regex requires some literal character: one outside bracket classes,
 * intervals, operators and groups, not made optional, an escaped punctuation
 * character included. Any alternative makes it require none, since the other
 * branch may match everything. It fails closed, so `[^/]*`, `.{0,}`, `.*|x`,
 * `.*x?` or `(x)?.*` has none.
 */
function regexHasLiteral(pattern: string): boolean {
	if (/\|/.test(pattern)) return false;
	let depth = 0;
	for (let at = 0; at < pattern.length; at++) {
		const char = pattern[at] as string;
		if (char === "\\") {
			const escaped = pattern[++at];
			if (escaped === "(") depth++;
			else if (escaped === ")") depth = Math.max(0, depth - 1);
			else if (
				escaped !== undefined &&
				!REGEX_ESCAPED_OPERATOR.test(escaped) &&
				depth === 0 &&
				!optionalAt(pattern, at + 1)
			)
				return true;
		} else if (char === "(") depth++;
		else if (char === ")") depth = Math.max(0, depth - 1);
		else if (char === "[") at = classEnd(pattern, at) - 1;
		else if (char === "{") {
			const close = pattern.indexOf("}", at);
			at = close < 0 ? pattern.length : close;
		} else if (!REGEX_OPERATORS.has(char) && depth === 0 && !optionalAt(pattern, at + 1)) return true;
	}
	return false;
}

/** A pattern that selects every file: only `*` and `?` for the glob tests, no literal character for the regex ones. */
function matchesEverything(test: string, pattern: string): boolean {
	if (test.endsWith("regex")) return !regexHasLiteral(pattern);
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
	if (name === "rm" && args.some(isRecursiveRm)) {
		for (const operand of operands(args)) {
			const kind = pathKind(operand, context);
			if (kind) return REMOVAL_RULE[kind];
		}
	}
	if (FIND_NAMES.includes(name)) {
		const kind = findRemovalKind(args, context);
		if (kind) return REMOVAL_RULE[kind];
	}
	if ((name === "chmod" || name === "chown") && args.some(isRecursiveCh))
		if (operands(args).some((operand) => pathKind(operand, context) === "root")) return "recursive chmod/chown on /";
	if (name === "git") return gitRule(args);
	return undefined;
}

/** Whether `arg` is `option` or a prefix of it git would take (`--ha` for `--hard`), with or without `=value`. */
function abbreviates(arg: string, option: string): boolean {
	const name = arg.split("=")[0] ?? "";
	return name.length > 2 && option.startsWith(name);
}

/**
 * A force spelling: `--force`, `--force-with-lease[=...]` or any prefix git accepts for them (`--fo`, `--force-w`),
 * or a short cluster with `f` (`-f`, `-fd`, `-xdf`). An ambiguous prefix such as `--f` fails closed.
 */
const isForce = (arg: string) => abbreviates(arg, "--force-with-lease") || /^-[a-zA-Z]*f/.test(arg);
/** `git push` options whose value is the next word, so a `+` there is not a refspec. */
const PUSH_VALUE_OPTIONS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/** Whether a `git push` forces: a force option or a `+src[:dst]` refspec. */
function pushForces(flags: readonly string[]): boolean {
	return flags.some(
		(arg, index) => isForce(arg) || (arg.startsWith("+") && !PUSH_VALUE_OPTIONS.has(flags[index - 1] ?? "")),
	);
}

/** The git commands gentle-shell always denies: they throw away work or rewrite a remote, and no confirmation makes that safe. */
function gitRule(args: readonly string[]): string | undefined {
	const { action, flags } = gitAction(args);
	if (action === "reset" && flags.some((arg) => abbreviates(arg, "--hard"))) return "git reset --hard";
	if (action === "clean" && flags.some(isForce)) return "forced git clean";
	if (action === "push" && pushForces(flags)) return "force push";
	return undefined;
}

/** The command lines a command runs itself: `sh -c`, `eval`, `find -exec`. */
function nestedCommands(name: string, args: readonly string[]): string[] {
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
	return nested;
}

/**
 * The command as the shell reads it after line continuations: a `\` before a newline is removed, even inside a
 * word, double quotes or an unquoted heredoc body, but not inside single quotes, a comment or a quoted heredoc body.
 */
function joinContinuations(command: string): string {
	const removed = new Set(readShell(command).continuations);
	let joined = "";
	for (let at = 0; at < command.length; at++) {
		if (removed.has(at)) at++;
		else joined += command[at];
	}
	return joined;
}

/**
 * The rule a command breaks, or undefined when the guard does not recognize it as destructive. A command with line
 * continuations is judged both joined and as written, so a continuation can neither hide a command nor, in a quoted
 * heredoc body where the shell keeps it, pull the next command into data.
 */
export function findDestructiveCommand(command: string, context: GuardContext, depth = 0): string | undefined {
	if (depth > MAX_DEPTH) return undefined;
	const joined = joinContinuations(command);
	return (
		destructiveRule(joined, context, depth) ??
		(joined === command ? undefined : destructiveRule(command, context, depth))
	);
}

/** A command of a line as the guard reads it: the wrappers passed on the way, then its words, unquoted and as written. */
export interface SimpleCommand {
	wrappers: string[];
	words: { value: string; raw: string }[];
	/** It redirects output to a file (`> out`, `2>> log`, `&> f`); `/dev/null` and a copied descriptor (`2>&1`) are no file. */
	writesFile: boolean;
}

/** Whether a segment's redirections write a file. */
function writesFile(segment: readonly Token[]): boolean {
	return segment.some((token, at) => {
		if (token.operator || !REDIRECTION.test(token.raw) || !token.raw.includes(">")) return false;
		if (/&(?:\d+|-)$/.test(token.raw)) return false;
		const target = BARE_REDIRECTION.test(token.raw) ? segment[at + 1]?.value : token.raw.replace(REDIRECTION, "");
		return target !== "/dev/null";
	});
}

/**
 * The simple commands of a line as the shell runs it (line continuations joined, heredoc bodies left out as data),
 * each past its assignments, redirections and wrappers; undefined when the line runs code no simple command shows: a
 * `$(...)` or backtick substitution, in the line or in an unquoted heredoc body, or a process substitution `<(...)`.
 */
export function simpleCommands(command: string): SimpleCommand[] | undefined {
	const joined = joinContinuations(command);
	const text = blankHeredocs(joined);
	if (substitutionBodies(text).length > 0 || heredocSubstitutions(joined).length > 0 || /[<>]\(/.test(text))
		return undefined;
	const tokens = tokenize(text);
	const commands: SimpleCommand[] = [];
	let start = 0;
	for (let end = 0; end <= tokens.length; end++) {
		if (end < tokens.length && !tokens[end]?.operator) continue;
		const queue = [tokens.slice(start, end)];
		start = end + 1;
		for (let at = 0; at < queue.length; at++) {
			const { segment, cursor, wrappers, extra } = head(queue[at] as Token[]);
			queue.push(...extra);
			const words = segment.slice(cursor).map(({ value, raw }) => ({ value, raw }));
			const writes = writesFile(segment);
			if (words.length > 0 || wrappers.length > 0 || writes) commands.push({ wrappers, words, writesFile: writes });
		}
	}
	return commands;
}

/** The rule a command breaks as written. */
function destructiveRule(command: string, context: GuardContext, depth: number): string | undefined {
	const text = blankHeredocs(command);
	if (hasForkBomb(text)) return "fork bomb";
	const tokens = tokenize(text);
	let start = 0;
	for (let end = 0; end <= tokens.length; end++) {
		if (end < tokens.length && !tokens[end]?.operator) continue;
		const queue = [tokens.slice(start, end)];
		start = end + 1;
		for (let at = 0; at < queue.length; at++) {
			const { segment, cursor, wrappers, extra } = head(queue[at] as Token[]);
			queue.push(...extra);
			if (wrappers.includes("sudo")) return "sudo";
			const first = segment[cursor];
			if (first === undefined) continue;
			const name = executable(first.value);
			const args = segment.slice(cursor + 1).map((token) => token.value);
			const nested = nestedCommands(name, args);
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
	}
	for (const body of [...substitutionBodies(text), ...heredocSubstitutions(command)]) {
		const found = findDestructiveCommand(body, context, depth + 1);
		if (found) return found;
	}
	return undefined;
}

/**
 * The commands `bash` asks the user about in every mode, even inside the sandbox: they delete or publish
 * work that cannot be taken back from the project. It follows gentle-shell's confirm list. Unlike the rules
 * above these are never refused. Recognition is by command position (segments, wrappers, `sh -c`, `eval`,
 * `find -exec`, `$(...)`), so prose that mentions a command, a `grep "git push"` or an `echo`, is never one.
 */
export interface ConfirmMatch {
	rule: string;
	/** `yolo` runs it without asking: a plain `git push` or `git rebase`, the reversible delivery. */
	yoloWaived: boolean;
}

const DATABASE_CLIENTS = new Set(["psql", "mysql", "mariadb", "sqlite3"]);

/** Whether SQL text drops or truncates, or deletes every row of a table (no `WHERE`, or one that is always true). */
function sqlDestroys(sql: string): boolean {
	// Quoted identifiers become non-keyword atoms; comments and strings go, so a table named "where" is no predicate.
	const code = sql.replace(
		/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]/g,
		(raw) => (/^["`[]/.test(raw) ? "identifier" : " "),
	);
	return code.split(";").some((statement) => {
		if (/^\s*(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW)\b|TRUNCATE\s+(?:TABLE\s+)?\S)/i.test(statement))
			return true;
		if (!/^\s*DELETE\s+FROM\s+\S/i.test(statement)) return false;
		return !/\bWHERE\b/i.test(statement) || /\bWHERE\s+(?:1\s*=\s*1|TRUE)\s*$/i.test(statement.trim());
	});
}

/** The SQL a database client command is given: its arguments, a heredoc body, or what `echo`/`printf` pipe into it. */
function sqlPayloads(
	command: string,
	head: Token,
	args: readonly string[],
	piped: readonly Token[] | undefined,
): string[] {
	// A long option's value, under any prefix the client accepts (`--comm=`, `--exec=`), is judged as SQL.
	const payloads = args.map((arg) => arg.replace(/^--[\w-]+=/, ""));
	const lineEnd = lineAt(command, head.index).end;
	const heredoc = heredocs(command).find(({ header }) => header >= head.index && header < lineEnd);
	if (heredoc) payloads.push(command.slice(heredoc.body, heredoc.terminator));
	if (piped && ["echo", "printf"].includes(executable(piped[0]?.value ?? "")))
		payloads.push(
			piped
				.slice(1)
				.map((token) => token.value)
				.join(" ")
				.replace(/^%s\s*/, ""),
		);
	return payloads;
}

/** Git's global options whose value may be the next word. */
const GIT_VALUE_OPTIONS = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source"];

/** The git subcommand and what follows it, past the global options that take a value. */
function gitAction(args: readonly string[]): { action: string | undefined; flags: string[]; at: number } {
	let at = 0;
	while (args[at]?.startsWith("-")) {
		const flag = args[at++];
		if (GIT_VALUE_OPTIONS.includes(flag ?? "")) at++;
	}
	return { action: args[at], flags: args.slice(at + 1), at };
}

function deletesBranchByForce(flags: readonly string[]): boolean {
	if (flags.some((arg) => /^-[a-zA-Z]*D/.test(arg))) return true;
	return flags.some(isForce) && flags.some((arg) => abbreviates(arg, "--delete") || /^-[a-zA-Z]*d/.test(arg));
}

// What `yolo` waives, following gentle-shell's list: a push or rebase is eligible only as a plain word list or
// from this set of options. Everything that deletes or rewrites a remote ref (`--delete`, `:dst` and `+src`
// refspecs, `--mirror`, `--prune`, `--all`, any force spelling), runs code (`--receive-pack`, `--exec`) or
// redirects (`--repo`, `-o`) is absent, so it asks like any other confirmation.
/** Output redirections that write nothing: to stdout or stderr, or to /dev/null. */
const QUIET_REDIRECT = String.raw`[12]?>&[12]|(?:[12]?|&)>>?\s*/dev/null(?![^\s;&|])`;
const PUSH_WAIVED = new RegExp(
	String.raw`^push(?:\s+(?:${QUIET_REDIRECT}|-u|--set-upstream|-q|--quiet|-v|--verbose|--tags|--follow-tags|--no-verify|--porcelain|[A-Za-z0-9_][A-Za-z0-9_./-]*(?::[A-Za-z0-9_][A-Za-z0-9_./-]*)?))*\s*$`,
);
const REBASE_WAIVED = new RegExp(
	String.raw`^rebase(?:\s+(?:${QUIET_REDIRECT}|--onto\s+[A-Za-z0-9_][A-Za-z0-9_./~^-]*|--continue|--abort|--skip|--autostash|--no-autostash|[A-Za-z0-9_][A-Za-z0-9_./~^-]*))*\s*$`,
);
/** A read-only filter that may follow a waived command in a pipe; git's output carries text the remote controls. */
const FILTER_WAIVED = new RegExp(
	String.raw`^(?:tail|head|cat|grep|wc)(?:\s+(?:${QUIET_REDIRECT}|[A-Za-z0-9_.,:=+/%@-]+|'[^'\n]*'|"[^"$\x60\\\n]*"))*\s*$`,
);
const PLAIN_PREFIX_WORD = /^(?:[A-Za-z_][A-Za-z_0-9]*=[^\s'"`$]*|env|-i|command)$/;
const PLAIN_PATH = /^[^\s'"`$;&|-][^\s'"`$;&|]*$/;

interface Part {
	tokens: Token[];
	/** The operator that ends it; empty for the last one. */
	separator: string;
}

function splitParts(tokens: readonly Token[]): Part[] {
	const parts: Part[] = [];
	let start = 0;
	for (let end = 0; end <= tokens.length; end++) {
		if (end < tokens.length && !tokens[end]?.operator) continue;
		parts.push({ tokens: tokens.slice(start, end), separator: tokens[end]?.value ?? "" });
		start = end + 1;
	}
	return parts;
}

/** Whether what runs after a push or rebase part keeps it reversible: no background job, and a pipe only into read-only filters. */
function endsPlainly(parts: readonly Part[], at: number): boolean {
	let last = at;
	while (parts[last]?.separator === "|") {
		const filter = parts[last + 1]?.tokens ?? [];
		if (!FILTER_WAIVED.test(filter.map((token) => token.raw).join(" "))) return false;
		last++;
	}
	return ["", ";", "&&", "||", "\n"].includes(parts[last]?.separator ?? "");
}

/** Whether a `git push` or `git rebase` part is the plain form `yolo` waives: a bare `git` (or `git -C <path>`), unwrapped, with eligible words. */
function isWaivablePart(
	parts: readonly Part[],
	at: number,
	segment: readonly Token[],
	cursor: number,
	gitFlags: number,
	action: "push" | "rebase",
): boolean {
	if (!segment.slice(0, cursor).every((token) => token.raw === token.value && PLAIN_PREFIX_WORD.test(token.value)))
		return false;
	const rest = segment.slice(cursor + 1);
	const globals = rest.slice(0, gitFlags);
	if (
		globals.length > 0 &&
		!(globals.length === 2 && globals[0]?.raw === "-C" && PLAIN_PATH.test(globals[1]?.raw ?? ""))
	)
		return false;
	const words = rest.slice(gitFlags).map((token) => token.raw);
	if (!(action === "push" ? PUSH_WAIVED : REBASE_WAIVED).test(words.join(" "))) return false;
	return endsPlainly(parts, at);
}

/** The confirm rules a simple command matches, given its name and arguments. */
function segmentConfirmations(
	command: string,
	parts: readonly Part[],
	at: number,
	queued: boolean,
	{ segment, cursor }: { segment: readonly Token[]; cursor: number },
): ConfirmMatch[] {
	const first = segment[cursor];
	if (first === undefined) return [];
	const name = executable(first.value);
	const args = segment.slice(cursor + 1).map((token) => token.value);
	const found: ConfirmMatch[] = [];
	const add = (rule: string, yoloWaived = false) => found.push({ rule, yoloWaived });
	if (name === "rm" && args.some(isRecursiveRm)) add("recursive removal");
	if (FIND_NAMES.includes(name)) {
		const deletes = args.some((arg) => arg === "-delete");
		const execRm = args.some((arg, index) => FIND_EXEC.has(arg) && runsRm(execCommand(args, index + 1).words));
		if (deletes || execRm) add("find deletion");
	}
	if (DATABASE_CLIENTS.has(name)) {
		const piped = parts[at - 1]?.separator === "|" ? parts[at - 1]?.tokens : undefined;
		if (sqlPayloads(command, first, args, piped).some(sqlDestroys)) add("SQL deletion");
	}
	if (name === "npm" && args.find((arg) => !arg.startsWith("-")) === "publish") add("npm publish");
	if (name === "git") {
		const { action, flags, at: gitFlags } = gitAction(args);
		// Only the segment the part itself starts can be waived; what a wrapper or `env -S` adds never is.
		const plain = !queued;
		if (action === "push" || action === "rebase")
			add(`git ${action}`, plain && isWaivablePart(parts, at, segment, cursor, gitFlags, action));
		if (action === "branch" && deletesBranchByForce(flags)) add("forced branch deletion");
	}
	return found;
}

/**
 * Every confirm rule `command` matches, one entry per match, in the order they appear. A command with line
 * continuations is judged both joined and as written, like the refusals, and `yolo` waives none of it.
 */
export function findConfirmCommands(command: string, depth = 0): ConfirmMatch[] {
	if (depth > MAX_DEPTH) return [];
	const joined = joinContinuations(command);
	if (joined === command) return confirmRules(command, depth);
	return [...confirmRules(joined, depth), ...confirmRules(command, depth)].map(({ rule }) => ({
		rule,
		yoloWaived: false,
	}));
}

/** The confirm rules a command matches as written. */
function confirmRules(command: string, depth: number): ConfirmMatch[] {
	const text = blankHeredocs(command);
	const parts = splitParts(tokenize(text));
	const matches: ConfirmMatch[] = [];
	// What another command line runs is never waived: `sh -c 'git push'` hides what the shell does.
	const nested = (payload: string) =>
		findConfirmCommands(payload, depth + 1).map(({ rule }) => ({ rule, yoloWaived: false }));
	parts.forEach((part, at) => {
		const queue = [part.tokens];
		for (let item = 0; item < queue.length; item++) {
			const resolved = head(queue[item] as Token[]);
			queue.push(...resolved.extra);
			const first = resolved.segment[resolved.cursor];
			if (first === undefined) continue;
			const args = resolved.segment.slice(resolved.cursor + 1).map((token) => token.value);
			for (const payload of nestedCommands(executable(first.value), args)) matches.push(...nested(payload));
			matches.push(...segmentConfirmations(command, parts, at, item > 0, resolved));
		}
	});
	for (const body of [...substitutionBodies(text), ...heredocSubstitutions(command)]) matches.push(...nested(body));
	return matches;
}
