import { describe, expect, it } from "vitest";
import { createBashTool } from "../src/index.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

const cwd = "/work/project";
const manager: SandboxManagerLike = {
	isSupportedPlatform: () => true,
	checkDependencies: () => ({ errors: [], warnings: [] }),
	initialize: async () => {},
	wrapWithSandbox: async (command) => command,
	cleanupAfterCommand: () => {},
	reset: async () => {},
};
const sandboxed = () => new Sandbox({ platform: "darwin", manager });
const unavailable = () => new Sandbox({ platform: "linux" });

/** What the bash gate says about a command: the approval it asks, or nothing when it runs without asking. */
async function gateOf(command: string, options: Parameters<typeof createBashTool>[0] = {}) {
	const tool = createBashTool({ sandbox: sandboxed(), ...options });
	return tool.gate?.({ command }, { cwd });
}

const CONFIRMED: [string, string][] = [
	// a backslash before a newline joins the lines, even inside a word
	["r\\\nm -r build", "recursive removal"],
	["rm \\\n  -r build", "recursive removal"],
	["git \\\n push origin feat", "git push"],
	["psql -c \\\n 'DROP TABLE users'", "SQL deletion"],
	// long options as any prefix the command accepts
	["rm --rec build", "recursive removal"],
	["rm --r build", "recursive removal"],
	["git branch --del --force old", "forced branch deletion"],
	["git branch --delete --fo old", "forced branch deletion"],
	["psql --comm='DROP TABLE users'", "SQL deletion"],
	["mysql --exec='DELETE FROM users'", "SQL deletion"],
	["rm -r build", "recursive removal"],
	["rm -rf build", "recursive removal"],
	["rm -R build", "recursive removal"],
	["rm --recursive build", "recursive removal"],
	["rm -rf ./src/old", "recursive removal"],
	["env FOO=1 rm -rf build", "recursive removal"],
	["cd build && rm -rf cache", "recursive removal"],
	["sh -c 'rm -rf build'", "recursive removal"],
	["echo $(rm -rf build)", "recursive removal"],
	["find . -name '*.log' -delete", "find deletion"],
	["find build -type f -exec rm {} +", "find deletion"],
	["find build -exec env rm {} ';'", "find deletion"],
	["psql -c 'DROP TABLE users'", "SQL deletion"],
	["psql --command='TRUNCATE users'", "SQL deletion"],
	["mysql -e 'DELETE FROM users'", "SQL deletion"],
	["mariadb -e 'drop database app'", "SQL deletion"],
	["sqlite3 app.db 'DELETE FROM users WHERE 1=1'", "SQL deletion"],
	["echo 'DROP TABLE users;' | psql", "SQL deletion"],
	["psql <<EOF\nTRUNCATE TABLE users;\nEOF", "SQL deletion"],
	["git push", "git push"],
	["git push -u origin feat", "git push"],
	["git -C ../other push", "git push"],
	["git rebase main", "git rebase"],
	["git rebase -i HEAD~3", "git rebase"],
	["git branch -D old", "forced branch deletion"],
	["git branch --delete --force old", "forced branch deletion"],
	["git branch -df old", "forced branch deletion"],
	["npm publish", "npm publish"],
	["npm publish --access public", "npm publish"],
];

const NOT_CONFIRMED = [
	"ls -la",
	"rm build/output.txt",
	"rm -f build/output.txt",
	"rmdir build",
	"grep 'git push' README.md",
	'grep "rm -rf" notes.txt',
	"echo git push",
	"echo 'rm -rf build'",
	'git commit -m "git push later"',
	"cat <<EOF\nrm -rf build\ngit push\nEOF",
	"find . -name '*.log'",
	"find . -type f -exec cat {} +",
	"psql -c 'SELECT * FROM users'",
	"psql -c 'DELETE FROM users WHERE id = 3'",
	"echo 'DROP TABLE users;'",
	"grep 'DROP TABLE' schema.sql",
	"git pull",
	"git branch -d merged",
	"git branch -a",
	"git status && git log",
	"npm install",
	"npm run publish-docs",
	"pnpm test",
	"echo 'rm \\\n -r build'",
	"rm --verbose build/output.txt",
	"git branch --delete merged",
	"psql --command='SELECT 1'",
];

describe("the confirm category of the guard", () => {
	it.each(CONFIRMED)("asks for %j (%s)", async (command, rule) => {
		const gate = await gateOf(command);
		expect(gate?.refusal).toBeUndefined();
		expect(gate?.approval?.command).toBe(command);
		expect(gate?.approval?.confirm).toContain(rule);
	});

	it.each(NOT_CONFIRMED)("does not ask for %j", async (command) => {
		const gate = await gateOf(command);
		expect(gate?.refusal).toBeUndefined();
		expect(gate?.approval).toBeUndefined();
	});

	it("asks without a sandbox too, and keeps the sandbox warning", async () => {
		const gate = await gateOf("rm -rf build", { sandbox: unavailable() });
		expect(gate?.approval).toMatchObject({ command: "rm -rf build", confirm: "recursive removal" });
		expect(gate?.warning).toBeDefined();
	});

	it("keeps the reason of an unsandboxed request next to the rule", async () => {
		const tool = createBashTool({ sandbox: sandboxed() });
		const gate = await tool.gate?.({ command: "npm publish", unsandboxed: true, reason: "needs network" }, { cwd });
		expect(gate?.approval).toMatchObject({ command: "npm publish", reason: "needs network", confirm: "npm publish" });
	});

	it("names every rule of a compound command once", async () => {
		const gate = await gateOf("rm -rf a && rm -rf b; git push");
		expect(gate?.approval?.confirm).toBe("recursive removal, git push");
	});

	it("refuses a catastrophic command first, without a question", async () => {
		const gate = await gateOf("rm -rf /");
		expect(gate?.approval).toBeUndefined();
		expect(gate?.refusal?.output).toBe("Refused: recursive removal of / — rm -rf /");
	});

	it("does not ask for the verifier's bash, which runs in a throwaway copy", async () => {
		const gate = await gateOf("rm -rf build", { withoutApproval: true, policy: "verifier" });
		expect(gate?.approval).toBeUndefined();
	});

	it("does not waive in yolo a push split over lines", async () => {
		expect((await gateOf("git push \\\n origin feat"))?.approval).toMatchObject({ confirm: "git push" });
		expect((await gateOf("git push \\\n origin feat"))?.approval?.yoloWaived).toBeUndefined();
	});

	it("asks nothing for an ordinary command", async () => {
		expect(await gateOf("pnpm test")).toEqual({});
	});
});

describe("what yolo waives", () => {
	const waived = async (command: string) => (await gateOf(command))?.approval?.yoloWaived === true;

	it.each([
		"git push",
		"git push -u origin feat",
		"git push --set-upstream origin feat:feat",
		"git push --follow-tags --no-verify",
		"git -C ../other push origin main",
		"git push 2>&1",
		"git push -u origin feat 2>&1 | tail -5",
		"GIT_TERMINAL_PROMPT=0 git push",
		"git rebase main",
		"git rebase --onto main old feat",
		"git rebase --continue",
		"git rebase --autostash origin/main",
		"git fetch && git rebase origin/main && git push",
		"git commit -m wip && git push -u origin feat",
	])("waives %j", async (command) => {
		expect(await waived(command)).toBe(true);
	});

	it.each([
		"git push --delete origin feat",
		"git push origin :feat",
		"git push --mirror",
		"git push --prune origin",
		"git push --all",
		"git push -o ci.skip",
		"git push --receive-pack=evil",
		"git -c core.sshCommand=evil push",
		"git push origin 'feat'",
		"git push > out.txt",
		"git push | sh",
		"git push | tee out.txt",
		"git push &",
		"sh -c 'git push'",
		"xargs git push",
		"timeout 5 git push",
		"echo $(git push)",
		"git rebase -i main",
		"git rebase --interactive main",
		"git rebase --exec 'make' main",
		"git push && rm -rf data",
		"git rebase main && npm publish",
		"git branch -D old",
		"rm -rf build",
		"npm publish",
		"psql -c 'TRUNCATE users'",
		"find . -delete",
	])("does not waive %j", async (command) => {
		expect(await waived(command)).toBe(false);
	});
});
