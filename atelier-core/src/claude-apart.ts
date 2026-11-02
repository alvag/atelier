import { type ChildProcess, spawn } from "node:child_process";

/**
 * The variable the TUI gives the core when it reports a Herdr pane, set to the pane's id; every process the core
 * starts inherits it.
 */
export const HERDR_PANE_VARIABLE = "ATELIER_HERDR_PANE";

/**
 * Whether Claude Code must run apart: the TUI runs in a Herdr pane, where Herdr takes any process of the pane's
 * foreground job for the pane's agent, and so a `claude` there for Claude Code instead of Atelier. Windows has no
 * process groups to set it apart.
 */
export function inHerdrPane(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform) {
	return platform !== "win32" && (env[HERDR_PANE_VARIABLE] ?? "") !== "";
}

/** How long the command's group has, after TERM, to finish what it was writing before KILL, in seconds. */
const GRACE_SECONDS = 2;

/**
 * The group leader: `sh -c APART atelier-claude <command> <args...>`. It starts a watcher, then becomes the command.
 * The watcher waits for fd 3, a pipe from Atelier, to close: when Atelier quits or dies, however it does, or once the
 * command has exited. It then sends TERM to the group, gives every process of it GRACE_SECONDS to finish, the whole
 * grace even when the command itself is already gone, and kills the whole group, itself included. The watcher ignores TERM, and so does its `sleep`; the command and the arguments come as
 * `"$@"`, never as part of this text, and the command does not get fd 3.
 */
const APART = [
	`{ trap '' TERM; read -r _ <&3; kill -TERM 0; sleep ${GRACE_SECONDS}; kill -KILL 0; } >/dev/null 2>&1 &`,
	"exec 3<&-",
	'exec "$@"',
].join("\n");

type Stdio = "pipe" | "ignore";

export interface ApartOptions {
	cwd?: string;
	env: Record<string, string | undefined>;
	/** The command's stdin, stdout and stderr. */
	stdio: [Stdio, Stdio, Stdio];
	signal?: AbortSignal;
}

/**
 * Runs `command` as the leader of a process group, and session, of its own, so it is not part of the terminal's
 * foreground job, with a watcher that ends that group when Atelier ends or the command exits. The child is the
 * command itself: its pid, its pipes, its exit.
 */
export function spawnApart(command: string, args: readonly string[], options: ApartOptions): ChildProcess {
	const child = spawn("/bin/sh", ["-c", APART, "atelier-claude", command, ...args], {
		...(options.cwd === undefined ? {} : { cwd: options.cwd }),
		env: options.env,
		...(options.signal === undefined ? {} : { signal: options.signal }),
		detached: true,
		stdio: [...options.stdio, "pipe"],
	});
	const watch = child.stdio[3];
	// The pipe only tells the watcher that Atelier is gone; nothing is written to it, and an error on it means nothing.
	watch?.on("error", () => {});
	child.once("exit", () => watch?.destroy());
	child.once("error", () => watch?.destroy());
	return child;
}

/** Ends the group of a child that `spawnApart` started, as its watcher does: TERM, the grace, then KILL. */
export function endApart(child: ChildProcess): void {
	child.stdio[3]?.destroy();
}
