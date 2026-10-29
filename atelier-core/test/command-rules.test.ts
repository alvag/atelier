import { describe, expect, it } from "vitest";
import { commandRules, coveredBy, isValidCommandRule } from "../src/index.ts";

describe("commandRules", () => {
	const DERIVED: [string, string[], boolean][] = [
		["ego-browser nodejs <<EOF\nawait page.goto('https://google.com')\nEOF", ["ego-browser nodejs"], true],
		["mkdir -p x && ego-browser nodejs <<'EOF'\nconsole.log(1)\nEOF", ["mkdir", "ego-browser nodejs"], true],
		["open file.png", ["open"], true],
		["npm install foo", ["npm install"], true],
		["node script.js", ["node"], false],
		["npm test 2>&1 | tail -5", ["npm test", "tail"], true],
		["(cd sub; open a.png)", ["cd sub", "open"], true],
		["open a.png; open b.png", ["open"], true],
		["/usr/bin/open a.png", ["/usr/bin/open"], true],
		["git -C dir status", ["git"], true],
		["python3 -m http.server", ["python3"], false],
		["python3.12 x.py", ["python3.12"], false],
		["julia script.jl", ["julia"], false],
		["py -3 x.py", ["py"], false],
		["pythonw x.py", ["pythonw"], false],
		["bun install", ["bun install"], false],
		["npx prettier .", ["npx prettier"], false],
		["pnpm dlx create-vite", ["pnpm dlx"], false],
		["pnpm exec vitest", ["pnpm exec"], false],
		["pnpm install", ["pnpm install"], true],
		["yarn dlx foo", ["yarn dlx"], false],
		["pipx run black", ["pipx run"], false],
		["uvx ruff", ["uvx ruff"], false],
		["xargs node < list", ["node"], false],
		["nohup timeout 5 deno run x.ts", ["deno run"], false],
		["time osascript -e 'x'", ["osascript"], false],
		["ls | xargs rm", ["ls", "rm"], true],
		["pnpm -r build", ["pnpm"], true],
		["pnpm -C . dlx foo", ["pnpm dlx"], false],
		["pnpm --filter x exec foo", ["pnpm exec"], false],
		["npm --prefix . exec foo", ["npm exec"], false],
		["yarn --cwd x dlx foo", ["yarn dlx"], false],
		["pipx --quiet run foo", ["pipx run"], false],
		["uv --quiet run x.py", ["uv run"], false],
		["npm test 2>&1 >/dev/null", ["npm test"], true],
		["ego-browser nodejs < script.js", ["ego-browser nodejs"], true],
	];
	it.each(DERIVED)("%s", (command, rules, always) => {
		expect(commandRules(command)).toEqual({ rules, always });
	});

	const NEVER: string[] = [
		"open $(ls *.png)",
		"open `ls`",
		"eval open x",
		"source ./env.sh",
		". ./env.sh",
		"sh -c 'open x'",
		"bash -c 'open x'",
		"diff <(ls a) <(ls b)",
		"cp x ~/.atelier/permissions.json",
		"cp x $HOME/.ATELIER/x",
		"ego-browser nodejs <<EOF\nrequire('fs').writeFileSync(process.env.HOME + '/.atelier/permissions.json', '')\nEOF",
		"ego-browser nodejs <<EOF\n$(touch x)\nEOF",
		"$TOOL run",
		"for f in *.png; do open $f; done",
		"cat x | xargs",
		"op*n x",
		"PATH=./bin:$PATH open x",
		"BASH_ENV=./f open x",
		"DYLD_INSERT_LIBRARIES=./l.dylib open x",
		"env FOO=1 open x",
		"env -P ./bin open x",
		"env -S 'PATH=./bin open' x",
		"PATH=./bin; open x",
		"export PATH=./bin && open x",
		"find . -exec sh -c 'x' \\;",
		"find . -name x -exec cp {} /tmp \\;",
		"caffeinate bash -c 'x'",
		"stdbuf -o0 open x",
		"arch -arm64 node x.js",
		"git -c alias.x='!sh' x",
		"git --config-env=core.pager=X log",
		"git rebase --exec 'x' main",
		"git submodule foreach 'x'",
		"open -a Terminal bash",
		"open x > ~/.zshrc",
		"ego-browser nodejs 2>> log",
		"open x &> out",
		"open x; > ~/.zshrc",
	];
	it.each(NEVER)("never covers %s", (command) => {
		expect(commandRules(command).rules).toBeUndefined();
		expect(
			coveredBy(command, [
				"open",
				"cp",
				"ego-browser nodejs",
				"eval",
				"sh",
				"bash",
				"diff",
				"cat",
				"ls",
				"find",
				"git",
				"export",
				"caffeinate",
				"stdbuf",
				"arch",
				"node",
				"git rebase",
				"git submodule",
			]),
		).toBe(false);
	});
});

describe("coveredBy", () => {
	it("covers a line only when every command is covered", () => {
		expect(coveredBy("mkdir -p x && ego-browser nodejs <<EOF\nx\nEOF", ["ego-browser nodejs"])).toBe(false);
		expect(coveredBy("mkdir -p x && ego-browser nodejs <<EOF\nx\nEOF", ["ego-browser nodejs", "mkdir"])).toBe(true);
	});

	it("a program's rule covers its subcommands, a subcommand's rule only that one", () => {
		expect(coveredBy("open -a Preview x.png", ["open"])).toBe(true);
		expect(coveredBy("npm install foo", ["npm"])).toBe(true);
		expect(coveredBy("npm install foo", ["npm install"])).toBe(true);
		expect(coveredBy("npm publish", ["npm install"])).toBe(false);
		expect(coveredBy("npm --global install", ["npm install"])).toBe(false);
	});

	it("never covers a launcher by its program's rule, wherever its subcommand is", () => {
		for (const [command, rule] of [
			["pnpm dlx evil", "pnpm"],
			["pnpm exec evil", "pnpm"],
			["pnpm -C . dlx evil", "pnpm"],
			["env pnpm exec x", "pnpm"],
			["timeout 5 pnpm dlx evil", "pnpm"],
			["yarn dlx evil", "yarn"],
			["npm exec evil", "npm"],
			["npm --prefix . x evil", "npm"],
			["pipx run evil", "pipx"],
			["uv run evil.py", "uv"],
		] as const)
			expect(coveredBy(command, [rule]), command).toBe(false);
		expect(coveredBy("pnpm -C . dlx foo", ["pnpm dlx"])).toBe(true);
		expect(coveredBy("pnpm install", ["pnpm"])).toBe(true);
		expect(coveredBy("ego-browser nodejs <<EOF\nx\nEOF", ["ego-browser"])).toBe(false);
		expect(coveredBy("ego-browser nodejs <<EOF\nx\nEOF", ["ego-browser nodejs"])).toBe(true);
		expect(coveredBy("runner sh -c x", ["runner", "runner sh"])).toBe(false);
	});

	it("compares the program as written", () => {
		expect(coveredBy("/usr/bin/open x", ["open"])).toBe(false);
		expect(coveredBy("./open x", ["open"])).toBe(false);
	});

	it("judges a line continuation joined", () => {
		expect(coveredBy("open \\\n x.png", ["open"])).toBe(true);
		expect(coveredBy("op\\\nen x.png", ["open"])).toBe(true);
		expect(coveredBy("ls && n\\\node x.js", ["ls", "nope"])).toBe(false);
	});

	it("covers nothing with no rules", () => {
		expect(coveredBy("open x", [])).toBe(false);
	});
});

describe("isValidCommandRule", () => {
	it.each(["open", "ego-browser nodejs", "npm install", "/usr/bin/open"])("accepts %s", (rule) => {
		expect(isValidCommandRule(rule, { always: true })).toBe(true);
	});
	it.each(["", " open", "open  x", "npm install foo", "open\n", "$X", "op*n"])("refuses %j", (rule) => {
		expect(isValidCommandRule(rule, { always: false })).toBe(false);
	});
	it("refuses an interpreter or launcher only for always", () => {
		for (const rule of ["node", "python3", "npx prettier", "pnpm dlx", "pipx run", "sudo"]) {
			expect(isValidCommandRule(rule, { always: true })).toBe(false);
			expect(isValidCommandRule(rule, { always: false })).toBe(true);
		}
	});
});

describe("the nesting cap", () => {
	it("covers a command behind eight wrappers and never one behind nine", () => {
		expect(coveredBy(`${"nohup ".repeat(8)}open x.png`, ["open"])).toBe(true);
		expect(coveredBy(`${"nohup ".repeat(9)}open x.png`, ["open"])).toBe(false);
		expect(commandRules(`${"nohup ".repeat(9)}open x.png`).rules).toBeUndefined();
	});
});
