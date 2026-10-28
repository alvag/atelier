import { randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Where a credential file is written before it replaces the real one, next to it: a folder hidden from the agent like
 * the files themselves, so what a crash leaves there can never be read.
 */
export const SECRET_TEMP_FOLDER = ".credentials-tmp";
/** A temporary older than this was left by a writer that died: it is deleted when the folder is read or written. */
const STALE_TEMP_MS = 60_000;

export class SecretFileError extends Error {
	override name = "SecretFileError";
	readonly code = "secret_file_error";
}

/** What is at `path`, without following a link; undefined when nothing is. */
function lstatOrUndefined(path: string) {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

/** Whether `folder` may hold credentials: a real folder of its own, not a link that would send them elsewhere. */
function safeFolder(folder: string): boolean {
	const stats = lstatOrUndefined(folder);
	return stats === undefined || (stats.isDirectory() && !stats.isSymbolicLink());
}

/** Sets an existing credential folder back to `0700`; one that is a link is never followed. */
function secureFolder(folder: string): void {
	const stats = lstatOrUndefined(folder);
	if (stats === undefined || !stats.isDirectory() || (stats.mode & 0o777) === 0o700) return;
	try {
		const handle = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		try {
			fchmodSync(handle, 0o700);
		} finally {
			closeSync(handle);
		}
	} catch {
		// Not ours to change; what it holds is still used.
	}
}

/** Creates `folder` as `0700`, or makes it so; refuses a link or anything that is not a folder. */
export function ensureSecretFolder(folder: string): void {
	if (!safeFolder(folder))
		throw new SecretFileError(
			`${folder} is a symbolic link or not a folder: Atelier keeps credentials only in a real folder; remove it and try again`,
		);
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	secureFolder(folder);
}

/** Deletes the temporaries of writers that died, and the ones earlier versions left next to the file. */
function sweepTemporaries(file: string): void {
	const now = Date.now();
	const old = (path: string) => {
		const stats = lstatOrUndefined(path);
		return stats !== undefined && now - stats.mtimeMs > STALE_TEMP_MS;
	};
	const temporaries = join(dirname(file), SECRET_TEMP_FOLDER);
	if (safeFolder(temporaries))
		for (const name of readdirOrEmpty(temporaries)) {
			const path = join(temporaries, name);
			if (old(path)) rmSync(path, { force: true });
		}
	const legacy = new RegExp(`^${basename(file).replace(/\./g, "\\.")}\\.[0-9a-f]+\\.tmp$`);
	for (const name of readdirOrEmpty(dirname(file)))
		if (legacy.test(name)) rmSync(join(dirname(file), name), { force: true });
}

function readdirOrEmpty(folder: string): string[] {
	try {
		return readdirSync(folder);
	} catch {
		return [];
	}
}

/**
 * Reads a credential file, never through a link: a folder or a file that is a link reads as no file, and nothing it
 * leads to is opened or changed. A file found with other permissions is set back to `0600`, its folder to `0700`.
 */
export function readSecretFile(file: string): string | undefined {
	const folder = dirname(file);
	if (!safeFolder(folder)) return undefined;
	secureFolder(folder);
	sweepTemporaries(file);
	let handle: number;
	try {
		handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		return undefined;
	}
	try {
		if (!fstatSync(handle).isFile()) return undefined;
		if ((fstatSync(handle).mode & 0o777) !== 0o600)
			try {
				fchmodSync(handle, 0o600);
			} catch {
				// Not ours to change; it is still used.
			}
		return readFileSync(handle, "utf8");
	} finally {
		closeSync(handle);
	}
}

/**
 * Replaces a credential file whole: written `0600` from its first byte in the hidden temporary folder, then renamed
 * over the file. Refuses a folder or a file that is a link, so credentials never land where a link leads.
 */
export function writeSecretFile(file: string, content: string): void {
	const folder = dirname(file);
	ensureSecretFolder(folder);
	if (lstatOrUndefined(file)?.isSymbolicLink())
		throw new SecretFileError(`${file} is a symbolic link: Atelier does not write credentials through it; remove it`);
	const temporaries = join(folder, SECRET_TEMP_FOLDER);
	ensureSecretFolder(temporaries);
	sweepTemporaries(file);
	const temporary = join(temporaries, `${basename(file)}.${randomBytes(6).toString("hex")}`);
	const handle = openSync(
		temporary,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		fchmodSync(handle, 0o600);
		writeSync(handle, content);
	} finally {
		closeSync(handle);
	}
	try {
		renameSync(temporary, file);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}
