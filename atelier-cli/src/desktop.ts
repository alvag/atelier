import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "@atelier/core";
import {
	CommandError,
	describeCommand,
	type Exec,
	execute,
	OWN_ROOT,
	readMarker,
	writeDesktopMarker,
} from "./install-marker.ts";

export interface DesktopOptions {
	/** The copy whose desktop to open; the repository this CLI runs from when absent. */
	root?: string;
	env: Record<string, string | undefined>;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	/** Starts Electron on the desktop directory and returns at once; detached by default. */
	open?: (binary: string, args: string[]) => void;
}

/** Builds the desktop app (`electron-vite build`, into atelier-desktop/out/). */
export function buildDesktop(exec: Exec): Promise<string> {
	return exec("pnpm", ["-C", "atelier-desktop", "build"]);
}

/** Installs the full dependencies, which Electron and the build tooling are among. */
export function installFull(exec: Exec): Promise<string> {
	return exec("pnpm", ["install", "--frozen-lockfile"]);
}

/** Starts Electron detached from the terminal, which comes back at once. */
function spawnDetached(binary: string, args: string[]): void {
	spawn(binary, args, { detached: true, stdio: "ignore" }).unref();
}

/** Opens the desktop app, installing and building it first when needed; returns the exit code. */
export async function runDesktop(options: DesktopOptions): Promise<number> {
	const root = options.root ?? OWN_ROOT;
	const exec: Exec = (file, args) => execute(file, args, root, options.env);
	const desktopDir = join(root, "atelier-desktop");
	const electron = join(desktopDir, "node_modules", ".bin", "electron");
	const built = () => existsSync(join(desktopDir, "out", "main", "index.js"));
	try {
		const marker = await readMarker(root);
		if (marker?.desktop === false) {
			options.stdout("Installing the desktop (Electron, about 200 MB), once...\n");
			await installFull(exec);
			await buildDesktop(exec);
			await writeDesktopMarker(root, true);
		} else {
			if (marker === undefined && !existsSync(electron)) {
				options.stderr("error: Electron is not installed in a development clone; run: pnpm install\n");
				return 1;
			}
			if (!built()) await buildDesktop(exec);
		}
		if (options.open === undefined) spawnDetached(electron, [desktopDir]);
		else options.open(electron, [desktopDir]);
		options.stdout(`Opened Atelier desktop ${VERSION}\n`);
		return 0;
	} catch (error) {
		if (!(error instanceof CommandError)) throw error;
		options.stderr(`error: ${describeCommand(error)}\n`);
		return 1;
	}
}
