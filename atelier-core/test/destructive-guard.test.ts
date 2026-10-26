import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { type AtelierEvent, createBashTool, FakeBackend, Session, type SessionOptions } from "../src/index.ts";
import { Sandbox, type SandboxManagerLike } from "../src/tools/sandbox.ts";

const cwd = "/work/project";
/** A sandbox that is there and wraps nothing. */
const manager: SandboxManagerLike = {
	isSupportedPlatform: () => true,
	checkDependencies: () => ({ errors: [], warnings: [] }),
	initialize: async () => {},
	wrapWithSandbox: async (command) => command,
	cleanupAfterCommand: () => {},
	reset: async () => {},
};
const unavailable = () => new Sandbox({ platform: "linux" });
const bash = (options: Parameters<typeof createBashTool>[0] = {}) =>
	createBashTool({ sandbox: unavailable(), ...options });

/** The refusal the guard gives a command, or undefined when it lets it through. Never runs the command. */
async function refusalOf(command: string, options?: Parameters<typeof createBashTool>[0]) {
	return (await bash(options).gate?.({ command }, { cwd }))?.refusal;
}

const REFUSED: [string, string][] = [
	// recursive removal of /, the home directory and the project root
	["rm -rf /", "recursive removal of /"],
	["rm -rf /*", "recursive removal of /"],
	["rm -fr /", "recursive removal of /"],
	["rm -r -f /", "recursive removal of /"],
	["rm -R /", "recursive removal of /"],
	["rm --recursive --force /", "recursive removal of /"],
	["rm -rf --no-preserve-root /", "recursive removal of /"],
	["rm -rf -- /", "recursive removal of /"],
	['rm -rf "/"', "recursive removal of /"],
	["rm -rf //", "recursive removal of /"],
	["rm -rf ~", "recursive removal of the home directory"],
	["rm -rf ~/", "recursive removal of the home directory"],
	["rm -rf ~/*", "recursive removal of the home directory"],
	["rm -rf $HOME", "recursive removal of the home directory"],
	['rm -rf "$HOME"', "recursive removal of the home directory"],
	[`rm -rf \${HOME}/`, "recursive removal of the home directory"],
	[`rm -rf ${homedir()}`, "recursive removal of the home directory"],
	["rm -rf .", "recursive removal of the project directory"],
	["rm -rf ./", "recursive removal of the project directory"],
	["rm -rf ./*", "recursive removal of the project directory"],
	["rm -rf /work/project", "recursive removal of the project directory"],
	["rm -rf /work/project/", "recursive removal of the project directory"],
	["rm -rf $PWD", "recursive removal of the project directory"],
	["rm -rf ..", "recursive removal of the project directory"],
	["rm -rf /work", "recursive removal of the project directory"],
	// wherever the command sits
	["echo hi; rm -rf /", "recursive removal of /"],
	["cd /tmp && rm -rf /", "recursive removal of /"],
	["false || rm -rf ~", "recursive removal of the home directory"],
	["ls | rm -rf /", "recursive removal of /"],
	["env FOO=1 rm -rf /", "recursive removal of /"],
	["FOO=1 rm -rf /", "recursive removal of /"],
	["nohup rm -rf / &", "recursive removal of /"],
	["timeout 5 rm -rf /", "recursive removal of /"],
	["/bin/rm -rf /", "recursive removal of /"],
	["if true; then rm -rf /; fi", "recursive removal of /"],
	["sh -c 'rm -rf /'", "recursive removal of /"],
	['bash -lc "echo hi && rm -rf ~"', "recursive removal of the home directory"],
	["eval 'rm -rf /'", "recursive removal of /"],
	["find . -exec rm -rf / \\;", "recursive removal of /"],
	// redirections before the command and env -S do not hide it (T6, third round)
	["2>errors.log sudo x", "sudo"],
	["2> errors.log sudo x", "sudo"],
	[">/tmp/out sudo x", "sudo"],
	["env 2>/dev/null sudo x", "sudo"],
	['env -S "sudo x"', "sudo"],
	['env --split-string="sudo x"', "sudo"],
	['env -i -S "rm -rf /"', "recursive removal of /"],
	["2>/dev/null rm -rf /", "recursive removal of /"],
	// find that removes everything under /, the home directory or the project
	["find / -exec rm -rf {} +", "recursive removal of /"],
	["find / -delete", "recursive removal of /"],
	["find ~ -delete", "recursive removal of the home directory"],
	["find $HOME -exec rm -r {} \\;", "recursive removal of the home directory"],
	["find . -delete", "recursive removal of the project directory"],
	["find .. -mindepth 1 -delete", "recursive removal of the project directory"],
	["find -L / -xdev -execdir rm -f {} +", "recursive removal of /"],
	["echo $(rm -rf /)", "recursive removal of /"],
	['echo "$(rm -rf /)"', "recursive removal of /"],
	["echo `rm -rf /`", "recursive removal of /"],
	["cat <<EOF\nhi\nEOF\nrm -rf /", "recursive removal of /"],
	// filesystems and devices
	["mkfs /dev/sda", "mkfs"],
	["mkfs.ext4 /dev/sda1", "mkfs"],
	["/sbin/mkfs.vfat /dev/disk2s1", "mkfs"],
	["echo x && mkfs -t ext4 /dev/sdb", "mkfs"],
	["dd if=/dev/zero of=/dev/sda bs=1M", "dd to a device"],
	["dd of=/dev/disk2 if=image.iso", "dd to a device"],
	["dd if=a of=/dev/rdisk0", "dd to a device"],
	["dd if=/dev/zero of=/dev/nvme0n1", "dd to a device"],
	// fork bombs
	[":(){ :|:& };:", "fork bomb"],
	[":(){ :|: & }; :", "fork bomb"],
	[":() { : | : & } ; :", "fork bomb"],
	["bomb() { bomb | bomb & }; bomb", "fork bomb"],
	["f(){ f|f&};f", "fork bomb"],
	["echo go; :(){ :|:& };:", "fork bomb"],
	["bash -c ':(){ :|:& };:'", "fork bomb"],
	// recursive chmod and chown on /
	["chmod -R 777 /", "recursive chmod/chown on /"],
	["chmod -R 777 /*", "recursive chmod/chown on /"],
	["chmod --recursive 755 /", "recursive chmod/chown on /"],
	["chmod -Rf 000 /", "recursive chmod/chown on /"],
	["chown -R root:root /", "recursive chmod/chown on /"],
	["chown -R me /", "recursive chmod/chown on /"],
	// sudo and su in any segment
	["sudo ls", "sudo"],
	["sudo -u bob ls", "sudo"],
	["echo hi && sudo ls", "sudo"],
	["ls | sudo tee /etc/x", "sudo"],
	["env sudo ls", "sudo"],
	["FOO=1 sudo ls", "sudo"],
	["/usr/bin/sudo ls", "sudo"],
	["xargs sudo ls", "sudo"],
	["echo $(sudo cat /etc/shadow)", "sudo"],
	['echo "$(sudo cat /etc/shadow)"', "sudo"],
	["sh -c 'sudo ls'", "sudo"],
	["su", "su"],
	["su -", "su"],
	["su root -c ls", "su"],
	["true; su -l bob", "su"],
	["/usr/bin/su -", "su"],
	// git that throws work away or rewrites a remote, like gentle-shell's hard deny
	["git reset --hard", "git reset --hard"],
	["git reset --hard HEAD~3", "git reset --hard"],
	["git -C ../other reset --hard origin/main", "git reset --hard"],
	["git --no-pager reset -q --hard", "git reset --hard"],
	["git clean -f", "forced git clean"],
	["git clean --force", "forced git clean"],
	["git clean -fd", "forced git clean"],
	["git clean -xdf", "forced git clean"],
	["git clean -d -x -f", "forced git clean"],
	["git clean -fn", "forced git clean"],
	["git push --force", "force push"],
	["git push -f origin main", "force push"],
	["git push -uf origin feat", "force push"],
	["git push --force-with-lease", "force push"],
	["git push --force-with-lease=main:abc123 origin main", "force push"],
	["git push origin +main", "force push"],
	["git push origin +feat:main", "force push"],
	["git -C /work/project -c core.pager=cat push --force", "force push"],
	["echo ok && git push -f", "force push"],
	["env GIT_TRACE=1 git reset --hard", "git reset --hard"],
	["nohup git clean -fdx &", "forced git clean"],
	["sh -c 'git push --force'", "force push"],
	["eval git reset --hard", "git reset --hard"],
	["echo $(git clean -f)", "forced git clean"],
	['env -S "git push -f"', "force push"],
	// git takes any unambiguous prefix of a long option
	["git reset --ha HEAD~1", "git reset --hard"],
	["git reset --har", "git reset --hard"],
	["git reset --h", "git reset --hard"],
	["git clean --fo", "forced git clean"],
	["git clean --forc -d", "forced git clean"],
	["git push --force-w origin HEAD:main", "force push"],
	["git push --forc", "force push"],
	["git push --force-with=main origin main", "force push"],
	["git --config-env core.x=Y reset --hard", "git reset --hard"],
	// a backslash before a newline joins the lines, even inside a word
	["git push\\\n --force", "force push"],
	["git re\\\nset --hard", "git reset --hard"],
	["git clean \\\n  -fd", "forced git clean"],
	['git push "origin" \\\n -f', "force push"],
	["sh -c 'git push \\\n -f'", "force push"],
	["echo x # comment \\\ngit reset --hard", "git reset --hard"],
	["cat <<'EOF'\nx\\\nEOF\ngit reset --hard", "git reset --hard"],
	["cat <<EOF\\\n; git reset --hard\nEOF", "git reset --hard"],
	// a heredoc ends at its first terminator line; what follows runs
	["cat <<-EOF\n\tx\n\tEOF\ngit reset --hard\nEOF", "git reset --hard"],
	["cat <<-'EOF'\n\tx\n\t\tEOF\ngit push --force\nEOF", "force push"],
	['cat <<-"EOF"\nx\n\tEOF\nrm -rf /\nEOF', "recursive removal of /"],
	["cat <<EOF\nEOF\ngit reset --hard\nEOF", "git reset --hard"],
	["cat <<<EOF\ngit reset --hard\nEOF", "git reset --hard"],
	['echo "<<EOF"\ngit reset --hard\nEOF', "git reset --hard"],
	["echo '<<EOF'\ngit reset --hard\nEOF", "git reset --hard"],
	["echo $((1<<X))\ngit reset --hard\nX", "git reset --hard"],
	["# cat <<EOF\ngit reset --hard\nEOF", "git reset --hard"],
	["cat <<A <<B; git reset --hard\na\nA\nb\nB", "git reset --hard"],
	["cat <<A <<B\nA\nB\nrm -rf /\nB", "recursive removal of /"],
];

const ALLOWED = [
	"rm -rf node_modules",
	"rm -rf ./node_modules",
	"rm -rf ./dist",
	"rm -rf dist/ build/",
	"rm -rf /tmp/build",
	"rm -rf /work/project/node_modules",
	"rm -rf ~/.cache/atelier-test",
	"rm -rf ./node_modules/.cache",
	"rm file.txt",
	"rm -f /tmp/x",
	"git status",
	"git commit -m 'drop sudo and mkfs from the docs'",
	"echo sudo",
	'echo "run sudo to fix it"',
	"echo su",
	"grep -rn su .",
	"sudoku --solve",
	"pseudo-tool",
	"ls ~/su",
	"cat <<'EOF'\nrm -rf /\nEOF",
	"cat > notes.md <<EOF\nsudo rm -rf ~\nmkfs /dev/sda\n:(){ :|:& };:\nEOF",
	"echo ':(){ :|:& };:'",
	"echo 'rm -rf /' > notes.txt",
	"dd if=/dev/zero of=disk.img bs=1M count=1",
	"dd if=a of=/dev/null",
	"chmod -R 755 ./dist",
	"chmod 644 file",
	"chown -R me ./src",
	"mkdir -p build && ls",
	"find . -name '*.log' -delete",
	"find . -type f -name '*.tmp' -exec rm {} +",
	"echo hi > out.txt",
	"2>/dev/null ls",
	'env -S "echo hi"',
	"find /tmp/build -exec rm -rf {} +",
	"find ~/project/dist -delete",
	"pnpm test && pnpm check",
	"echo $(date)",
	"git reset --soft HEAD~1",
	"git reset HEAD file.txt",
	"git reset --mixed",
	"git clean -n",
	"git clean -nd",
	"git clean --dry-run",
	"git push",
	"git push -u origin feat",
	"git push origin feat:main",
	"git push -o ci.skip origin feat",
	'grep -rn "git reset --hard" .',
	"echo git push --force",
	"echo 'git clean -fdx'",
	"git commit -m 'never git push --force'",
	"git log --grep=--force",
	"git checkout -f main",
	"git push --follow-tags",
	"git push --fol origin",
	"git reset --soft \\\n HEAD~1",
	"echo 'git reset \\\n--hard'",
	"cat <<-EOF\n\tgit reset --hard\n\tgit push --force\n\trm -rf /\n\tEOF",
	"cat > notes.md <<-'EOF'\n\trm -rf /\nEOF\necho done",
	"cat <<A <<B\nrm -rf /\nA\ngit reset --hard\nB\necho done",
	"cat <<EOF\n'unbalanced quote\nEOF\necho done",
];

describe("the destructive command guard", () => {
	it.each(REFUSED)("refuses %j", async (command, rule) => {
		const refusal = await refusalOf(command);
		expect(refusal?.output).toBe(`Refused: ${rule} — ${command}`);
	});

	it.each(ALLOWED)("does not refuse %j", async (command) => {
		expect((await refusalOf(command)) === undefined).toBe(true);
	});

	it("applies to the verifier's bash too, which asks for nothing", async () => {
		const refusal = await refusalOf("rm -rf /", { withoutApproval: true, policy: "verifier" });
		expect(refusal?.output).toBe("Refused: recursive removal of / — rm -rf /");
	});

	it("gives the user a one-line summary that names the rule and the first line of the command", async () => {
		const refusal = await refusalOf("echo start\nsudo ls");
		expect(refusal).toEqual({
			output: "Refused: sudo — echo start\nsudo ls",
			summary: "Refused: sudo — echo start",
		});
	});

	it("does not run a refused command when the tool is called directly", async () => {
		const result = await bash().execute({ command: "sudo -n true" }, { cwd });
		expect(result).toEqual({
			ok: false,
			output: "Refused: sudo — sudo -n true",
			summary: "Refused: sudo — sudo -n true",
			truncated: false,
		});
	});
});

describe("the guard in a session", () => {
	async function ask(command: string, options: Partial<SessionOptions> = {}) {
		const questions: unknown[] = [];
		const backend = new FakeBackend([[{ toolCall: { tool: "bash", input: { command }, callId: "c1" } }]]);
		const session = await Session.start({
			backend,
			cwd,
			tools: [bash({ sandbox: new Sandbox({ platform: "darwin", manager }) })],
			approve: async (request) => {
				questions.push(request);
				return true;
			},
			...options,
		});
		const events: AtelierEvent[] = [];
		for await (const event of session.send("go")) events.push(event);
		return { events, questions, results: backend.toolResults };
	}

	it.each([
		["asks nothing", {}],
		["asks nothing in auto", { permissionMode: "auto" }],
		["asks nothing in yolo", { permissionMode: "yolo" }],
	] as const)("refuses a destructive command and %s", async (_name, options) => {
		const { events, questions, results } = await ask("sudo -n true", options);
		expect(results).toEqual([{ ok: false, output: "Refused: sudo — sudo -n true" }]);
		expect(questions).toEqual([]);
		expect(events.some((event) => event.type === "approval_requested")).toBe(false);
		expect(events.find((event) => event.type === "tool_call_finished")).toMatchObject({
			ok: false,
			summary: "Refused: sudo — sudo -n true",
		});
	});

	it("does not refuse or ask about an ordinary command", async () => {
		const { events, questions, results } = await ask("echo hi");
		expect(questions).toEqual([]);
		expect(events.some((event) => event.type === "approval_requested")).toBe(false);
		expect(results[0]?.output).not.toMatch(/^Refused/);
	});
});
