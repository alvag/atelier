import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
	candidate: z.string(),
	corrected: z.string().nullable(),
	risk: z.object({ level: z.enum(["passive", "medium", "high"]), reasons: z.array(z.string()) }),
	lenses: z.array(z.enum(LENSES)),
	findings: z.array(findingSchema),
	refuted: z.array(refutedSchema),
	followUps: z.array(findingSchema),
	correction: z.object({ budget: z.number(), used: z.number() }).nullable(),
	verdict: z.enum(["approved", "escalated", "declined", "unavailable"]),
	unavailableReason: z.string().optional(),
	/** Why an escalated review was handed back to the human. */
	escalatedReason: z.string().optional(),
	/** Why an escalated or unavailable review ended so, from a closed set, and the value observed. */
	cause: z.enum(REFUSAL_CAUSES).optional(),
	observed: z.string().optional(),
	/** When the user undid the escalated correction, putting the candidate's files back. */
	undoneAt: z.string().optional(),
	usage: usageSchema,
	costUsd: z.number().optional(),
});

export type Receipt = z.infer<typeof receiptSchema>;

/** Candidate trees are git object ids; anything else could name a path outside the reviews directory. */
const TREE = /^[0-9a-f]{40,64}$/;

function receiptPath(gitDir: string, tree: string): string {
	if (!TREE.test(tree)) throw new Error(`Not a tree id: ${tree}`);
	return join(gitDir, "atelier", "reviews", `${tree}.json`);
}

/**
 * Writes `<gitDir>/atelier/reviews/<candidate tree>.json` through a temporary
 * file in the same directory and a rename, so a reader never sees half a
 * receipt. Nothing is ever written inside the worktree.
 */
export async function writeReceipt(gitDir: string, receipt: Receipt): Promise<string> {
	const file = receiptPath(gitDir, receipt.candidate);
	const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
	await ensurePlainDirectory(join(gitDir, "atelier"));
	await ensurePlainDirectory(join(gitDir, "atelier", "reviews"));
	try {
		await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	return file;
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

/** The receipt of a candidate tree; undefined when there is none or the file is unreadable or invalid. */
export async function findReceipt(gitDir: string, candidateTree: string): Promise<Receipt | undefined> {
	try {
		const parsed = receiptSchema.safeParse(JSON.parse(await readFile(receiptPath(gitDir, candidateTree), "utf8")));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}
