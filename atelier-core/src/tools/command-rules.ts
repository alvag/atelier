import { redirectionOf, type SimpleCommand, simpleCommands } from "./destructive-guard.ts";

/**
 * The rules the user can allow a `bash` command by: one per program and
 * subcommand (`open`, `npm install`, `ego-browser nodejs`), derived from what
 * the guard reads in the line. A rule with only the program covers every use
 * of it; one with a subcommand covers only that subcommand. A line is covered
 * when each of its commands is. What cannot be told from the words (a
 * substitution, `eval`, `sh -c`, a control structure, a program named by a
 * variable or a glob, a redirection to a file, any mention of `.atelier`) is
 * never covered, and asks.
 *
 * A rule is kept for the session, in a project, or always. Interpreters and
 * launchers run whatever code they are given: only for the session. Programs that
 * run code the repository defines (package scripts, makefiles, a program written
 * as a relative path) only in a project, so a rule allowed in one never runs a
 * freshly cloned repository's scripts. Everything else may be allowed always.
 */

/** Programs that run whatever code they are given: never allowed always. */
const INTERPRETERS = new Set([
	"node",
	"nodejs",
	"deno",
	"bun",
	"bash",
	"sh",
	"zsh",
	"dash",
	"ksh",
	"mksh",
	"fish",
	"csh",
	"tcsh",
	"ruby",
	"irb",
	"perl",
	"php",
	"lua",
	"luajit",
	"osascript",
	"awk",
	"gawk",
	"mawk",
	"nawk",
	"tclsh",
	"expect",
	"pwsh",
	"Rscript",
	"julia",
	"py",
	"pythonw",
	"npx",
	"pnpx",
	"bunx",
	"uvx",
	"sudo",
]);
const PYTHON = /^(?:python|pypy)[0-9.]*$/;
/**
 * Subcommands that download or run arbitrary code, by program: never allowed always, and never covered by the
 * program's own rule. Options can come before them (`pnpm -C . dlx`), so any of the program's words that is one counts.
 */
const LAUNCHERS: Record<string, readonly string[]> = {
	npm: ["exec", "x"],
	pnpm: ["dlx", "exec"],
	yarn: ["dlx", "exec"],
	pipx: ["run"],
	uv: ["run"],
};

/**
 * Programs that run code the repository defines, whatever their subcommand: package scripts and lifecycle hooks,
 * makefiles, build scripts, test configuration. Their rules are kept for a project, never for every folder.
 */
const PROJECT_PROGRAMS = new Set([
	"npm",
	"pnpm",
	"yarn",
	"make",
	"gmake",
	"just",
	"rake",
	"gradle",
	"mvn",
	"cargo",
	"go",
	"pip",
	"pip3",
	"poetry",
	"pdm",
	"hatch",
	"uv",
	"composer",
	"bundle",
	"mix",
	"dotnet",
	"swift",
	"xcodebuild",
	"cmake",
	"ninja",
	"pytest",
	"tox",
	"nox",
	"vitest",
	"jest",
]);
/** Commands that change the directory later commands of the line run in. */
const CHANGES_DIRECTORY = new Set(["cd", "pushd", "popd"]);
/**
 * Whether a word may name a place outside the project, failing closed: an expansion the shell does (`$HOME`, `${x}`,
 * `~`, a brace list, an unquoted glob), any `..`, or an absolute path, by itself or attached to an option (`-C/x`, `--dir=/x`, `--dir/x`)
 * or a value (`file:/x`, `foo@/x`).
 */
function leavesProject({ value, raw }: { value: string; raw: string }): boolean {
	if (/[$`~{]/.test(raw) || value.includes("~")) return true;
	// A `..` segment of any place the word names, also after `:`, `,` or `=` (`-C../x`, `file:../lib`); `./...` is none.
	if (placesOf(value).some((place) => place.split(/[/:,=]/).includes(".."))) return true;
	// A glob the shell expands (`l?nk`, `lin[k]`, `l*`) may name any place: only quoted or escaped it is literal.
	if (/[*?[]/.test(raw.replace(/'[^']*'|"(?:\\.|[^"\\])*"|\\./g, ""))) return true;
	return /(?:^|[=:,@])\/|^-[A-Za-z0-9]+\/|^--[\w-]+\//.test(value);
}

/** The places a word may name: itself, and the value of an option it carries (`--dir=x`, `-Cx`). */
function placesOf(value: string): string[] {
	const places = [value];
	const equals = value.indexOf("=");
	if (equals > 0) places.push(value.slice(equals + 1));
	if (/^-[A-Za-z0-9]/.test(value) && value.length > 2) places.push(value.slice(2));
	return places.filter((place) => place !== "");
}

/**
 * Options with which a project's program runs code its value names or holds, by program: never covered by a project
 * rule, whatever their value. A two-character one (`-E`) counts also in a cluster of short options (`-kE`).
 */
const RUNS_CODE_OPTIONS: Record<string, readonly string[]> = {
	make: ["--eval", "-E"],
	gmake: ["--eval", "-E"],
	npm: ["--node-options", "--script-shell", "--shell", "--userconfig", "--globalconfig"],
	pnpm: ["--node-options", "--script-shell", "--shell", "--userconfig", "--globalconfig", "--config."],
	yarn: ["--node-options", "--script-shell", "--shell", "--userconfig", "--globalconfig"],
	cargo: ["--config", "-Z"],
	go: ["-exec", "-toolexec", "--exec", "--toolexec"],
	gradle: ["--init-script", "-I"],
	gradlew: ["--init-script", "-I"],
};

/** Whether `word` is one of `options`: as it is, with `=value`, a prefix ending in `.` (`--config.x`), or a short one in a cluster. */
function isRunsCodeOption(word: string, options: readonly string[]): boolean {
	return options.some((option) => {
		if (option.endsWith(".")) return word.startsWith(option);
		if (option.length === 2) return new RegExp(`^-[A-Za-z0-9]*${option[1]}`).test(word);
		return word === option || word.startsWith(`${option}=`);
	});
}

/**
 * Whether an argument is a simple word, the only kind a project rule covers: letters, digits and `. _ - @ + , : %`
 * (`*` and `?` only when quoted, as globs unquoted already ask), `/` only inside a relative path (never first, nor
 * after `=`, `:`, `,`, nor in an option, `-I/x`), no space or control character, and `=` only in a long option
 * `--name=value` whose value is one too, never an assignment `NAME=value`.
 */
function isSimpleArgument(value: string): boolean {
	const long = /^--[A-Za-z0-9][A-Za-z0-9._-]*=/.exec(value);
	const text = long === null ? value : value.slice(long[0].length);
	if (!/^[A-Za-z0-9._@+,:%*?/-]*$/.test(text)) return false;
	if (text.startsWith("/") || /[:,]\//.test(text) || /^-[^/]*\//.test(text)) return false;
	return true;
}

/** The arguments of a command: its words after the program, without redirections and the files they name. */
function argumentsOf(words: SimpleCommand["words"]): SimpleCommand["words"] {
	const args: SimpleCommand["words"] = [];
	for (let at = 1; at < words.length; at++) {
		const word = words[at] as SimpleCommand["words"][number];
		const redirection = redirectionOf(word.raw);
		if (redirection === "bare") at++;
		else if (redirection === undefined) args.push(word);
	}
	return args;
}

/** Programs whose line is not one command the words show: they run a string, a file in this shell, or a structure. */
const NEVER = new Set([
	"eval",
	"source",
	".",
	"for",
	"case",
	"esac",
	"select",
	"function",
	"fi",
	"done",
	"}",
	"[[",
	"((",
	"coproc",
	// Builtins that change what later commands run: their PATH, functions or aliases.
	"export",
	"declare",
	"typeset",
	"local",
	"readonly",
	"alias",
	"set",
	"unset",
	"shopt",
	"trap",
	// Runners of another command the guard does not pass over as wrappers.
	"caffeinate",
	"stdbuf",
	"arch",
	"watch",
	"script",
	"parallel",
	"flock",
	"chroot",
	"unbuffer",
	"ionice",
	"taskset",
	"sandbox-exec",
]);

/** Options and subcommands with which a program runs other code: a command with one is never covered. */
const RUNS_CODE: Record<string, readonly string[]> = {
	find: ["-exec", "-execdir", "-ok", "-okdir"],
	git: [
		"-c",
		"--config-env",
		"--exec",
		"-x",
		"--upload-pack",
		"--receive-pack",
		"--extcmd",
		"foreach",
		"run",
		"filter-branch",
		"difftool",
		"mergetool",
	],
};

/** Whether a word is a long option of `options` with its value attached (`--exec=x`) or one of them as it is. */
const isOneOf = (value: string, options: readonly string[]) =>
	options.some((option) => value === option || (option.startsWith("--") && value.startsWith(`${option}=`)));
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "fish", "csh", "tcsh"]);

const PROGRAM = /^(?!-)(?!\.$)[A-Za-z0-9_./+@:-]+$/;
const SUBCOMMAND = /^[a-z][a-z0-9-]*$/;
const MENTIONS_PROTECTED = /\.atelier|permissions\.json/i;

interface Key {
	program: string;
	subcommand?: string;
	/** Runs arbitrary code: an interpreter, a launcher, or a wrapper that becomes one. */
	runsCode: boolean;
	/** A launcher's subcommand: only the rule that names it (`pnpm dlx`) covers it, never the program's alone. */
	launcher: boolean;
	/** Runs code the repository defines: its rules are kept for a project, never always. */
	project: boolean;
	/** One of its words names a place outside the project: no project rule covers it. */
	leavesProject: boolean;
	/** The places its words may name, as written: the words, an option's attached value (`-Cdir`, `--dir=dir`). */
	places: string[];
	/** Its standard input comes from the line (a pipe, `<`, a heredoc, a here-string): code no project rule covers. */
	readsInput: boolean;
	/** Every argument is a simple word and none is an option that runs code: only then may a project rule cover the line. */
	simpleArguments: boolean;
}

const ruleOf = ({ program, subcommand }: Key) => (subcommand === undefined ? program : `${program} ${subcommand}`);

function isRunner(program: string, subcommand: string | undefined): boolean {
	const name = program.split("/").at(-1) ?? program;
	return INTERPRETERS.has(name) || PYTHON.test(name) || (subcommand !== undefined && isLauncher(name, subcommand));
}

/** Whether a program runs code the repository defines: a package manager or build runner, or a relative path (`./gradlew`). */
function isProjectProgram(program: string): boolean {
	const name = program.split("/").at(-1) ?? program;
	return PROJECT_PROGRAMS.has(name) || (program.includes("/") && !program.startsWith("/"));
}

/** Whether a word names an interpreter or a launcher program, by itself or as a path (`/bin/sh`). */
function isInterpreter(word: string): boolean {
	const name = word.split("/").at(-1) ?? word;
	return INTERPRETERS.has(name) || PYTHON.test(name);
}

const isLauncher = (name: string, subcommand: string) => LAUNCHERS[name]?.includes(subcommand) === true;

/** The first of the program's words that is one of its launchers, wherever options put it. */
function launcherOf(name: string, words: SimpleCommand["words"]): string | undefined {
	return words.slice(1).find(({ value }) => isLauncher(name, value))?.value;
}

/** The key of one command, or undefined when it can never be covered. */
function keyOf({ wrappers, words, writesFile, setsEnvironment, readsInput }: SimpleCommand): Key | undefined {
	const [first, second] = words;
	if (writesFile || setsEnvironment || first === undefined || first.raw !== first.value || !PROGRAM.test(first.value))
		return undefined;
	const program = first.value;
	const name = program.split("/").at(-1) ?? program;
	if (NEVER.has(name)) return undefined;
	// A shell given a string runs it: nothing in the words says what that is.
	const shellString = ({ value }: { value: string }) => /^-[a-z]*c[a-z]*$/.test(value);
	if (SHELLS.has(name) && words.some(shellString)) return undefined;
	// Code the program runs on its own: its options for that, or an interpreter named after its subcommand (`find . -exec sh`).
	const runsCode = RUNS_CODE[name];
	if (runsCode !== undefined && words.slice(1).some(({ value }) => isOneOf(value, runsCode))) return undefined;
	if (words.slice(2).some(({ value }) => isInterpreter(value))) return undefined;
	// A subcommand named like an interpreter (`ego-browser nodejs`) is the program running code: only its own rule covers it.
	const runsInterpreter = second !== undefined && isInterpreter(second.value);
	if (runsInterpreter && SHELLS.has(second.value.split("/").at(-1) ?? "") && words.slice(2).some(shellString))
		return undefined;
	const launcher = launcherOf(name, words);
	const subcommand =
		launcher ??
		(second !== undefined && second.raw === second.value && SUBCOMMAND.test(second.value) ? second.value : undefined);
	return {
		program,
		...(subcommand === undefined ? {} : { subcommand }),
		runsCode: wrappers.includes("sudo") || isRunner(program, subcommand),
		launcher: launcher !== undefined || runsInterpreter,
		project: isProjectProgram(program),
		// `xargs` adds arguments read from its input, which the words never show.
		// The program is what runs, not a place it works in: only a `..` or `~` in it (`../other/gradlew`) leaves.
		leavesProject: wrappers.includes("xargs") || /\.\.|~/.test(program) || words.slice(1).some(leavesProject),
		// A program written as a relative path (`./run.sh`) is the project's: a link there may lead out of it.
		places: [
			...(program.includes("/") && !program.startsWith("/") ? [program] : []),
			...words.slice(1).flatMap(({ value }) => placesOf(value)),
		],
		readsInput,
		simpleArguments: argumentsOf(words).every(
			({ value }) => isSimpleArgument(value) && !isRunsCodeOption(value, RUNS_CODE_OPTIONS[name] ?? []),
		),
	};
}

/** The keys of every command of a line, or undefined when one of them can never be covered. */
function keysOf(command: string): Key[] | undefined {
	if (MENTIONS_PROTECTED.test(command)) return undefined;
	const commands = simpleCommands(command);
	if (commands === undefined || commands.length === 0) return undefined;
	const keys: Key[] = [];
	for (const simple of commands) {
		const key = keyOf(simple);
		if (key === undefined) return undefined;
		keys.push(key);
	}
	return keys;
}

export interface CommandRules {
	/** The rule of each command of the line, in order and without repeats; undefined when the line can never be covered. */
	rules: string[] | undefined;
	/** Whether the rules may be allowed always: no command of the line runs arbitrary code or code the repository defines. */
	always: boolean;
	/** Set when the rules may be allowed always in this project, not everywhere: a command of the line runs code the repository defines. */
	project?: true;
}

/** The rules that would cover `command`, as the question offers them. */
export function commandRules(command: string): CommandRules {
	const keys = keysOf(command);
	if (keys === undefined) return { rules: undefined, always: false };
	const rules = [...new Set(keys.map(ruleOf))];
	if (keys.some((key) => key.runsCode)) return { rules, always: false };
	return keys.some((key) => key.project) ? { rules, always: false, project: true } : { rules, always: true };
}

/** Whether a rule of `rules` covers the command of `key`. */
const covers = (rules: ReadonlySet<string>, key: Key) =>
	(!key.launcher && rules.has(key.program)) || (key.subcommand !== undefined && rules.has(ruleOf(key)));

/**
 * Whether the allowed rules cover every command of the line. `project` are the rules allowed always in this
 * session's project: they cover a command only when no command of the line can take it elsewhere (no `cd`, `pushd`
 * or `popd`, no `xargs`, no word that names a place outside the project). `inProject` tells whether a place a word
 * names, relative to the command's directory, really is in the project (a link in it may lead out); it is asked only
 * when a project rule is needed, and without it every place counts as in.
 */
export function coveredBy(
	command: string,
	allowed: Iterable<string>,
	project: Iterable<string> = [],
	inProject: (place: string) => boolean = () => true,
): boolean {
	const rules = new Set(allowed);
	const projectRules = new Set(project);
	if (rules.size === 0 && projectRules.size === 0) return false;
	const keys = keysOf(command);
	if (keys === undefined) return false;
	if (keys.every((key) => covers(rules, key))) return true;
	// A project rule holds the whole line to the project: any command of it can hand a place to the one it covers.
	const staysInProject = !keys.some(
		(key) =>
			CHANGES_DIRECTORY.has(key.program) || key.leavesProject || !key.simpleArguments || !key.places.every(inProject),
	);
	// What a command reads from the line (`make -f - <<EOF`) is code the words do not show: only a session or global rule covers it.
	return staysInProject && keys.every((key) => covers(rules, key) || (!key.readsInput && covers(projectRules, key)));
}

/** How broadly `rule` may be kept: only for the session, in a project, or always; undefined when it is no rule `commandRules` could give. */
export function commandRuleScope(rule: string): "session" | "project" | "always" | undefined {
	const [program, subcommand, ...rest] = rule.split(" ");
	if (program === undefined || rest.length > 0 || !PROGRAM.test(program)) return undefined;
	if (subcommand !== undefined && !SUBCOMMAND.test(subcommand)) return undefined;
	if (NEVER.has(program.split("/").at(-1) ?? program)) return undefined;
	if (isRunner(program, subcommand)) return "session";
	return isProjectProgram(program) ? "project" : "always";
}

/** Whether `rule` is one `commandRules` could give; with `always`, also one that may be allowed always, in every folder. */
export function isValidCommandRule(rule: string, { always }: { always: boolean }): boolean {
	const scope = commandRuleScope(rule);
	return scope !== undefined && (!always || scope === "always");
}
