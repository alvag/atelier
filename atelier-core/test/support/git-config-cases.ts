import { execFileSync } from "node:child_process";
import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const gitConfigCases = [
	"plain repository",
	"hooks path",
	"nested include",
	"conditional include",
	"uppercase and spaced subsection",
	"padded value",
	"quoted and multiline values",
	"duplicate hooks path",
	"linked worktree",
	"broken include",
	"missing include",
	"malformed config",
	"unreadable config",
	"valueless entries",
	"combined output exceeds the old buffer",
	"individual output exceeds the old buffer",
	"invalid UTF-8 below the old buffer",
	"get-all just over the old buffer",
	"combined output exceeds the finite buffer",
] as const;

export async function gitConfigFixture(base: string, kind: (typeof gitConfigCases)[number]) {
	let cwd = join(base, "repo");
	const home = join(base, "home");
	await mkdir(cwd, { recursive: true });
	await mkdir(home, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
	git("init", "-q");
	let config = join(cwd, ".git", "config");
	const protectedPaths = [config, join(cwd, ".git", "hooks", "pre-commit")];
	const allowedPaths = [join(cwd, "ordinary.cfg")];
	const add = (text: string) => appendFile(config, text);
	const include = async (value: string, text = "# included\n") => {
		const path = join(dirname(config), value);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, text);
		protectedPaths.push(path);
		return path;
	};

	switch (kind) {
		case "hooks path":
			git("config", "core.hooksPath", join(base, "outside hooks"));
			protectedPaths.push(join(base, "outside hooks", "pre-commit"));
			break;
		case "nested include":
			await add("[include]\npath = ../outer.cfg\n");
			await include("../outer.cfg", "[include]\npath = nested/deep.cfg\n");
			await include("../nested/deep.cfg");
			break;
		case "conditional include":
		case "uppercase and spaced subsection":
			await add(
				`[includeIf "${kind === "conditional include" ? "gitdir:/never/" : "gitdir/i:~/Work Dir/"}"]\npath = ../conditional.cfg\n`,
			);
			await include("../conditional.cfg");
			break;
		case "padded value":
			await add('[include]\npath = " padded.cfg "\n');
			await include(" padded.cfg ");
			break;
		case "quoted and multiline values":
			await add('[include]\npath = "../team \\"quote\\"\\nline.cfg"\npath = ../con\\\ntinued.cfg\n');
			await include('../team "quote"\nline.cfg');
			await include("../continued.cfg");
			break;
		case "duplicate hooks path":
			// Force the fallback to read hooksPath from this file, not from rev-parse.
			await add('[core]\nhooksPath = first-hooks\nhooksPath = " last hooks "\n[include]\npath = ../broken.cfg\n');
			await include("../broken.cfg", "[invalid\n");
			protectedPaths.push(join(cwd, " last hooks ", "pre-commit"));
			allowedPaths.push(join(cwd, "first-hooks", "pre-commit"));
			break;
		case "linked worktree": {
			git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "base");
			git("config", "extensions.worktreeConfig", "true");
			const linked = join(base, "linked");
			git("worktree", "add", "-q", "--detach", linked);
			config = join(cwd, ".git", "worktrees", "linked", "config.worktree");
			cwd = linked;
			allowedPaths[0] = join(cwd, "ordinary.cfg");
			await add("[include]\npath = worktree.cfg\n");
			await include("worktree.cfg");
			protectedPaths.push(config, join(cwd, ".git"));
			break;
		}
		case "broken include":
			await add("[core]\nhooksPath = custom-hooks\n[include]\npath = ../broken.cfg\n");
			await include("../broken.cfg", "[invalid\n");
			protectedPaths.push(join(cwd, "custom-hooks", "pre-commit"));
			break;
		case "missing include":
			await add("[include]\npath = ../missing.cfg\n");
			protectedPaths.push(join(cwd, "missing.cfg"));
			break;
		case "malformed config":
			await add("[core]\nhooksPath = custom-hooks\n[include]\npath = ../fallback.cfg\n[invalid\n");
			await include("../fallback.cfg");
			protectedPaths.push(join(cwd, "custom-hooks", "pre-commit"));
			break;
		case "unreadable config":
			await add("[include]\npath = ../unreadable/config\n");
			await include("../unreadable/config");
			await chmod(join(cwd, "unreadable", "config"), 0);
			break;
		case "invalid UTF-8 below the old buffer": {
			await add('[include]\npath = "../team#cfg"\n');
			const line = Buffer.concat([Buffer.from("path = junk/"), Buffer.alloc(200, 0xff), Buffer.from("\n")]);
			await appendFile(config, Buffer.concat(Array.from({ length: 1800 }, () => line)));
			await include("../team#cfg");
			break;
		}
		case "combined output exceeds the finite buffer":
			// Repeated hooks values grow the combined output, but the old --get returns only the last one.
			await add(`[core]\n${`hooksPath = ${"x".repeat(128)}\n`.repeat(32_768)}hooksPath = final-hooks\n`);
			await add('[include]\npath = "../team#cfg"\n');
			await include("../team#cfg");
			protectedPaths.push(join(cwd, "final-hooks", "pre-commit"));
			break;
		case "get-all just over the old buffer":
			await add(`[include]\n${'path = "../team#cfg"\n'.repeat(89_048)}`);
			await include("../team#cfg");
			break;
		case "combined output exceeds the old buffer":
			await add(`[include]\n${'path = "../team#cfg"\n'.repeat(50_000)}`);
			await include("../team#cfg");
			break;
		case "individual output exceeds the old buffer":
			await add(`[include]\n${'path = "../team#cfg"\n'.repeat(100_000)}`);
			// The old get-all exceeds 1 MiB too and is cut; the fallback parser keeps the quoted '#'.
			await include("../team#cfg");
			break;
		case "valueless entries":
			await add('[include]\npath\n[includeIf "gitdir:/never/"]\npath\n[core]\nhooksPath = unused\nhooksPath\n');
			// An empty hooks path resolves to the repository itself in the fallback.
			allowedPaths.length = 0;
			protectedPaths.push(join(cwd, "empty-hooks"));
			break;
	}
	for (const path of [...protectedPaths, ...allowedPaths]) {
		if (kind === "missing include" && path === join(cwd, "missing.cfg")) continue;
		if (kind === "unreadable config" && path === join(cwd, "unreadable", "config")) continue;
		await mkdir(dirname(path), { recursive: true });
		if ((await readFile(path, "utf8").catch(() => undefined)) === undefined) await writeFile(path, "original\n");
	}
	return { cwd, home, protectedPaths, allowedPaths };
}
