import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { REFUSAL_CAUSES } from "../events.ts";
import { findingSchema } from "./findings.ts";
import { LENSES } from "./risk.ts";

const usageSchema = z.object({
	input: z.number(),
	output: z.number(),
	cacheRead: z.number(),
	cacheWrite: z.number(),
});
const refutedSchema = findingSchema.extend({ reason: z.string() });

/**
 * A record of one review, not an authority: it enables nothing, it only says
 * what was reviewed and keeps the same candidate from being offered twice.
 * `findings` holds the confirmed blocking findings, `refuted` those the refuter
 * dropped, and `followUps` everything else the lenses reported.
 */
export const receiptSchema = z.object({
	schema: z.literal("atelier.review-receipt/v1"),
	id: z.string(),
	createdAt: z.string(),
	base: z.string(),
	/** The receipt of the approved review whose candidate tree is `base`, when the base advanced to it; absent otherwise. */
	previousReview: z.string().optional(),
	candidate: z.string(),
	corrected: z.string().nullable(),
	risk: z.object({ level: z.enum(["passive", "medium", "high"]), reasons: z.array(z.string()) }),
	lenses: z.array(z.enum(LENSES)),
	findings: z.array(findingSchema),
	refuted: z.array(refutedSchema),
	followUps: z.array(findingSchema),
	correction: z.object({ budget: z.number(), used: z.number() }).nullable(),
	/** How many parts the lenses reviewed the change in, when it was too large for one prompt; absent for one. */
	parts: z.number().int().min(2).optional(),
	verdict: z.enum(["approved", "escalated", "declined", "unavailable"]),
	unavailableReason: z.string().optional(),
	/** Why an escalated review was handed back to the human. */
	escalatedReason: z.string().optional(),
	/** Why an escalated or unavailable review ended so, from a closed set, and the value observed. */
	cause: z.enum(REFUSAL_CAUSES).optional(),
	observed: z.string().optional(),
	/** When the user undid the escalated correction, putting the candidate's files back. */
	undoneAt: z.string().optional(),
	/** The tree of HEAD when the review ended, which tells a later commit of the correction; absent in older receipts. */
	headTree: z.string().optional(),
	usage: usageSchema,
	costUsd: z.number().optional(),
});

export type Receipt = z.infer<typeof receiptSchema>;

/** Candidate trees are git object ids; anything else could name a path outside the reviews directory. */
const TREE = /^[0-9a-f]{40,64}$/;
/** `<tree>-<review id>.json`, or the older `<tree>.json` (no id), which stays readable as it is. */
const RECEIPT_FILE = /^([0-9a-f]{40,64})(?:-[A-Za-z0-9_.-]+)?\.json$/;

/** A receipt and the file it is stored in, which only its writer chooses. */
export interface StoredReceipt {
	file: string;
	receipt: Receipt;
}

function reviewsDir(gitDir: string): string {
	return join(gitDir, "atelier", "reviews");
}

/** One file per review, so a second review of the same tree never replaces an earlier receipt. */
function receiptPath(gitDir: string, tree: string, id: string): string {
	if (!TREE.test(tree)) throw new Error(`Not a tree id: ${tree}`);
	return join(reviewsDir(gitDir), `${tree}-${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

/**
 * Writes `<gitDir>/atelier/reviews/<candidate tree>-<review id>.json` through a temporary
 * file in the same directory and a rename, so a reader never sees half a
 * receipt. Nothing is ever written inside the worktree.
 */
export async function writeReceipt(gitDir: string, receipt: Receipt): Promise<string> {
	const file = receiptPath(gitDir, receipt.candidate, receipt.id);
	await replaceReceipt(gitDir, file, receipt);
	return file;
}

/** Writes `receipt` over `file`, a receipt file of this repository found by `findReceipts`, with the same care as `writeReceipt`. */
export async function replaceReceipt(gitDir: string, file: string, receipt: Receipt): Promise<void> {
	const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
	await ensurePlainDirectory(join(gitDir, "atelier"));
	await ensurePlainDirectory(reviewsDir(gitDir));
	try {
		await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

/**
 * Creates the directory, or checks the one there is a real directory: a symbolic
 * link could send receipts out of the git directory, into the worktree or anywhere.
 */
async function ensurePlainDirectory(path: string): Promise<void> {
	try {
		const found = await lstat(path);
		if (found.isSymbolicLink() || !found.isDirectory())
			throw new Error(`${path} is not a plain directory; receipts are only written inside the git directory.`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		await mkdir(path, { mode: 0o700 });
	}
}

/** Every readable, valid receipt of the repository, newest first; unreadable or invalid files are skipped. */
async function readAll(gitDir: string): Promise<StoredReceipt[]> {
	const dir = reviewsDir(gitDir);
	const names = await readdir(dir).catch(() => [] as string[]);
	const found: StoredReceipt[] = [];
	for (const name of names) {
		if (!RECEIPT_FILE.test(name)) continue;
		try {
			const parsed = receiptSchema.safeParse(JSON.parse(await readFile(join(dir, name), "utf8")));
			if (parsed.success) found.push({ file: join(dir, name), receipt: parsed.data });
		} catch {}
	}
	return found.sort((a, b) => b.receipt.createdAt.localeCompare(a.receipt.createdAt) || b.file.localeCompare(a.file));
}

/** The receipts of a candidate tree, newest first by `createdAt`, the legacy `<tree>.json` among them. */
export async function findReceipts(gitDir: string, candidateTree: string): Promise<StoredReceipt[]> {
	if (!TREE.test(candidateTree)) return [];
	const all = await readAll(gitDir);
	return all.filter(({ file }) => RECEIPT_FILE.exec(basename(file))?.[1] === candidateTree);
}

/** The most recent receipt of a candidate tree; undefined when there is none. */
export async function findReceipt(gitDir: string, candidateTree: string): Promise<Receipt | undefined> {
	return (await findReceipts(gitDir, candidateTree))[0]?.receipt;
}

/** The latest escalated review of the repository that left a correction, by `createdAt`; unreadable receipts are skipped. */
export async function latestCorrection(gitDir: string): Promise<Receipt | undefined> {
	return (await readAll(gitDir)).find(({ receipt }) => receipt.verdict === "escalated" && receipt.corrected !== null)
		?.receipt;
}
