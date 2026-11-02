/**
 * The host a session runs in, told once at its start from the environment: the TUI's notifications, its herdr pane
 * reporting and herdr-app's skill ask the answer instead of reading the variables themselves.
 */

/** Orca; herdr, the one with a socket (0.9.x); herdr-app, over a herdr-core terminal; or none of them. */
export type HostKind = "orca" | "herdr" | "herdr-app" | "other";

/** What a host takes from Atelier. */
export interface HostSupports {
	/** In `auto`: `host` notifies by itself, so nothing is sent; `bell` becomes the host's own; `terminal` asks the terminal. */
	notifications: "host" | "bell" | "terminal";
	/** herdr-app's guide, listed as the skill `herdr-app`. */
	herdrAppSkill: boolean;
	/** Reporting the agent to herdr's pane through its socket. */
	herdrPanes: boolean;
}

export interface Host {
	/** The nearest host. */
	kind: HostKind;
	/** Every host whose variables are set, the nearest first; empty outside them. */
	seen: Exclude<HostKind, "other">[];
	supports: HostSupports;
	/** herdr's pane and socket as the environment gives them, for the reporter to check; only when herdr is the host. */
	herdr?: { paneId: string | undefined; socketPath: string | undefined };
}

/** The order taken when TERM_PROGRAM names none of the hosts seen. */
const FALLBACK: Exclude<HostKind, "other">[] = ["herdr-app", "herdr", "orca"];

/**
 * Orca and herdr write their own name in TERM_PROGRAM, and herdr-core turns `herdr` into `ghostty`, so with several
 * hosts' variables inherited the name says which is nearest. herdr-core keeps the TERM_PROGRAM of whoever asked for the
 * terminal, so any other name points at herdr-app.
 */
const STAMPS: Record<string, Exclude<HostKind, "other">> = { Orca: "orca", herdr: "herdr" };

const SUPPORTS: Record<HostKind, HostSupports> = {
	orca: { notifications: "bell", herdrAppSkill: false, herdrPanes: false },
	herdr: { notifications: "host", herdrAppSkill: false, herdrPanes: true },
	"herdr-app": { notifications: "host", herdrAppSkill: true, herdrPanes: false },
	other: { notifications: "terminal", herdrAppSkill: false, herdrPanes: false },
};

/** The hosts whose variables `env` has; an empty value is none. */
function hostsIn(env: Record<string, string | undefined>): Exclude<HostKind, "other">[] {
	const present = {
		"herdr-app": Boolean(env.HC_TERMINAL_ID),
		herdr: env.HERDR_ENV === "1",
		orca: Boolean(env.ORCA_PANE_KEY),
	};
	return FALLBACK.filter((kind) => present[kind]);
}

/** The host `env` says the session runs in: with one host's variables, that host; with several, the nearest. */
export function detectHost(env: Record<string, string | undefined>): Host {
	const found = hostsIn(env);
	const stamped = STAMPS[env.TERM_PROGRAM ?? ""];
	const kind = stamped !== undefined && found.includes(stamped) ? stamped : (found[0] ?? "other");
	const seen = kind === "other" ? [] : [kind, ...found.filter((other) => other !== kind)];
	const host: Host = { kind, seen, supports: { ...SUPPORTS[kind] } };
	if (kind === "herdr") host.herdr = { paneId: env.HERDR_PANE_ID, socketPath: env.HERDR_SOCKET_PATH };
	return host;
}
