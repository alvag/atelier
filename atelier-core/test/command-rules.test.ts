import { describe, expect, it } from "vitest";
import { commandRuleScope, commandRules, coveredBy, isValidCommandRule } from "../src/index.ts";

describe("commandRules", () => {
	const DERIVED: [string, string[], boolean, "project"?][] = [
		["ego-browser nodejs <<EOF\nawait page.goto('https://google.com')\nEOF", ["ego-browser nodejs"], true],
		["mkdir -p x && ego-browser nodejs <<'EOF'\nconsole.log(1)\nEOF", ["mkdir", "ego-browser nodejs"], true],
		["open file.png", ["open"], true],
		["npm install foo", ["npm install"], false, "project"],
		["node script.js", ["node"], false],
		["npm test 2>&1 | tail -5", ["npm test", "tail"], false, "project"],
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
		["pnpm install", ["pnpm install"], false, "project"],
		["yarn dlx foo", ["yarn dlx"], false],
		["pipx run black", ["pipx run"], false],
		["uvx ruff", ["uvx ruff"], false],
		["xargs node < list", ["node"], false],
		["nohup timeout 5 deno run x.ts", ["deno run"], false],
		["time osascript -e 'x'", ["osascript"], false],
		["ls | xargs rm", ["ls", "rm"], true],
		["pnpm -r build", ["pnpm"], false, "project"],
		["pnpm -C . dlx foo", ["pnpm dlx"], false],
		["pnpm --filter x exec foo", ["pnpm exec"], false],
		["npm --prefix . exec foo", ["npm exec"], false],
		["yarn --cwd x dlx foo", ["yarn dlx"], false],
		["pipx --quiet run foo", ["pipx run"], false],
		["uv --quiet run x.py", ["uv run"], false],
		["npm test 2>&1 >/dev/null", ["npm test"], false, "project"],
		["ego-browser nodejs < script.js", ["ego-browser nodejs"], true],
		["make", ["make"], false, "project"],
		["make -j4 test", ["make"], false, "project"],
		["yarn build", ["yarn build"], false, "project"],
		["cargo test", ["cargo test"], false, "project"],
		["/opt/homebrew/bin/npm ci", ["/opt/homebrew/bin/npm ci"], false, "project"],
		["./gradlew build", ["./gradlew build"], false, "project"],
		["bin/dev", ["bin/dev"], false, "project"],
		["mkdir -p x && pnpm install", ["mkdir", "pnpm install"], false, "project"],
		["pnpm install && npx foo", ["pnpm install", "npx foo"], false],
	];
	it.each(DERIVED)("%s", (command, rules, always, project) => {
		expect(commandRules(command)).toEqual({ rules, always, ...(project === undefined ? {} : { project: true }) });
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
		"cp x ~/.atelier/project-permissions.json",
		"cp x project-permissions.json",
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
	it.each(["open", "ego-browser nodejs", "/usr/bin/open"])("accepts %s", (rule) => {
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

describe("commandRuleScope", () => {
	it.each([
		["open", "always"],
		["ego-browser nodejs", "always"],
		["npm install", "project"],
		["npm", "project"],
		["pnpm", "project"],
		["make", "project"],
		["./gradlew", "project"],
		["scripts/build.sh", "project"],
		["node", "session"],
		["pnpm dlx", "session"],
		["julia", "session"],
		["op*n", undefined],
		["eval", undefined],
	] as const)("%s may be kept %s", (rule, scope) => {
		expect(commandRuleScope(rule)).toBe(scope);
	});

	it("never allows a project program always", () => {
		expect(isValidCommandRule("npm install", { always: true })).toBe(false);
		expect(isValidCommandRule("npm install", { always: false })).toBe(true);
	});
});

describe("coveredBy with project rules", () => {
	it("covers by a project rule as by any other", () => {
		expect(coveredBy("pnpm install", [], ["pnpm install"])).toBe(true);
		expect(coveredBy("pnpm -r build", [], ["pnpm"])).toBe(true);
		expect(coveredBy("mkdir x && pnpm install", ["mkdir"], ["pnpm install"])).toBe(true);
		expect(coveredBy("pnpm install src/lib", [], ["pnpm install"])).toBe(true);
		expect(coveredBy("make -C sub -j4 test", [], ["make"])).toBe(true);
		expect(coveredBy("/usr/bin/make -C sub", [], ["/usr/bin/make"])).toBe(true);
		expect(coveredBy('pnpm --filter "@app/*" build', [], ["pnpm"])).toBe(true);
		expect(coveredBy("make test\\*", [], ["make"])).toBe(true);
		expect(coveredBy("pnpm --filter ./packages/web build", [], ["pnpm"])).toBe(true);
		expect(coveredBy("pnpm dlx evil", [], ["pnpm"])).toBe(false);
	});

	it.each([
		"cd ../other && pnpm install",
		"pushd /tmp/x; pnpm install",
		"pnpm install; popd",
		"pnpm -C /other install",
		"pnpm -C/other install",
		"pnpm --dir=/other install",
		"npm --prefix ~/other install",
		"make -C ../other",
		"make --directory=../other",
		"pnpm install ../lib",
		"../other/gradlew build",
		"make -C../other",
		"make -f../other/Makefile",
		'make -C "$HOME/other"',
		"make -C $HOME/other",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell expands it, not JavaScript
		"make -C ${HOME}/other",
		"make -C~/other",
		"make --directory/x",
		"make -C {/tmp,x}",
		"pnpm --dir=~/x install",
		"npm install file:../lib",
		"npm install foo@/x",
		"make -C l?nk",
		"make -C lin[k]",
		"make -C l*",
		"make -Cl*",
	])("never covers %s by a project rule: it can leave the project", (command) => {
		expect(
			coveredBy(command, ["cd", "pushd", "popd"], ["pnpm", "pnpm install", "npm", "make", "../other/gradlew"]),
		).toBe(false);
	});

	it("never covers by a project rule a command whose arguments xargs reads from its input", () => {
		expect(coveredBy("printf '/tmp/other\\n' | xargs make -C", ["printf"], ["make"])).toBe(false);
		expect(coveredBy("xargs make -C < targets.txt", [], ["make"])).toBe(false);
		expect(coveredBy("xargs make -C < targets.txt", ["make"])).toBe(true);
	});

	it("holds the whole line to the project's bounds when a project rule covers one of its commands", () => {
		expect(coveredBy("printf '%s' /tmp | make -f -", ["printf"], ["make"])).toBe(false);
		expect(coveredBy("printf x | xargs echo; make", ["printf", "echo"], ["make"])).toBe(false);
		expect(coveredBy("printf '%s' /tmp", ["printf"], ["make"])).toBe(true);
		expect(coveredBy("printf x; make", ["printf"], ["make"])).toBe(true);
	});

	it("asks the caller whether each place a word names stays in the project", () => {
		const asked: string[] = [];
		const inside = (path: string) => {
			asked.push(path);
			return path !== "link";
		};
		expect(coveredBy("make -C link", [], ["make"], inside)).toBe(false);
		expect(coveredBy("printf x | make -Clink", ["printf"], ["make"], inside)).toBe(false);
		expect(coveredBy("make --directory=link", [], ["make"], inside)).toBe(false);
		expect(coveredBy("make -C sub", [], ["make"], inside)).toBe(true);
		expect(asked).toContain("sub");
		// A line no project rule needs to cover is never looked at.
		asked.length = 0;
		expect(coveredBy("make -C link", ["make"], ["make"], inside)).toBe(true);
		expect(asked).toEqual([]);
	});

	it.each([
		"make -f - <<'EOF'\ninclude /outside/Makefile\nEOF",
		"make -f - <<< 'include /outside/Makefile'",
		"make -f - < /outside/Makefile",
		"make -f - < Makefile.in",
		"make -f - 0<Makefile.in",
		"printf 'include /tmp/M\\n' | make -f -",
		"printf x |& make -f -",
		"printf x | (make -f -)",
		"printf x | { make -f -; }",
		"(make -f -) < Makefile.in",
		"make -f -<payload.mk",
		"make -f -<<'EOF'\ninclude /outside/Makefile\nEOF",
		"make -f -<<<'include /outside/Makefile'",
	])("never covers by a project rule a command whose standard input another part of the line gives: %j", (command) => {
		expect(coveredBy(command, ["printf"], ["make"])).toBe(false);
	});

	it("still covers by a project rule a command that reads no input from the line", () => {
		expect(coveredBy("pnpm test", [], ["pnpm"])).toBe(true);
		expect(coveredBy("pnpm test 2>&1 | tail -5", ["tail"], ["pnpm"])).toBe(true);
		expect(coveredBy("pnpm test || printf failed", ["printf"], ["pnpm"])).toBe(true);
		// A session rule covers it as before.
		expect(coveredBy("printf x | make -f -", ["printf", "make"])).toBe(true);
		expect(coveredBy("make -f - <<< 'all:'", ["make"])).toBe(true);
		expect(coveredBy("printf x | (make -f -)", ["printf", "make"])).toBe(true);
		expect(coveredBy("(make -f -) < payload.mk", ["make"])).toBe(true);
		expect(coveredBy("make 'a<b'", [], ["make"])).toBe(true);
	});

	it("still covers such a line by a session rule", () => {
		expect(coveredBy("pnpm -C /other install", ["pnpm"])).toBe(true);
	});
});

describe("the nesting cap", () => {
	it("covers a command behind eight wrappers and never one behind nine", () => {
		expect(coveredBy(`${"nohup ".repeat(8)}open x.png`, ["open"])).toBe(true);
		expect(coveredBy(`${"nohup ".repeat(9)}open x.png`, ["open"])).toBe(false);
		expect(commandRules(`${"nohup ".repeat(9)}open x.png`).rules).toBeUndefined();
	});
});
