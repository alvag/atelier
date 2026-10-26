import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PERMISSION_MODES, type PermissionMode } from "./modes.ts";

export { PERMISSION_MODES };

const KIND = "atelier.permission_mode";
const VERSION = 1;

export interface DefaultPermissionMode {
	mode: PermissionMode;
	/** Why the file was not used: `<path>: <reason>; using normal`. Absent when the file is missing or valid. */
	problem?: string;
}

const modePath = (home: string) => join(home, ".atelier", "permission-mode.json");

function isMode(value: unknown): value is PermissionMode {
	return PERMISSION_MODES.some((mode) => mode === value);
}

/** Reads the global default in `<home>/.atelier/permission-mode.json`. A missing file is `normal`; an invalid one is `normal` with a problem to tell the user. */
export async function readDefaultPermissionMode(home: string): Promise<DefaultPermissionMode> {
	const path = modePath(home);
	const fallback = (reason: string): DefaultPermissionMode => ({
		mode: "normal",
		problem: `${path}: ${reason}; using normal`,
	});
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { mode: "normal" };
		return fallback(`cannot read it: ${(error as Error).message}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return fallback("not valid JSON");
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return fallback(`expected kind "${KIND}" and version ${VERSION}`);
	const file = raw as Record<string, unknown>;
	if (file.kind !== KIND || file.version !== VERSION) return fallback(`expected kind "${KIND}" and version ${VERSION}`);
	if (!isMode(file.default)) return fallback('"default" must be normal, auto or yolo');
	return { mode: file.default };
}

/** Writes the global default through a temporary file and a rename, so a reader never sees half a file. */
export async function writeDefaultPermissionMode(home: string, mode: PermissionMode): Promise<void> {
	const path = modePath(home);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify({ kind: KIND, version: VERSION, default: mode }, null, 2)}\n`);
		await rename(temporary, path);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
