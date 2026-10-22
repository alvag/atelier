import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { bashTool, readTool } from "../src/tools/index.ts";

// Regressions found by the independent U3 verification.

it("S5: bounds Unicode read output and reports truncation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "atelier-regression-"));
	try {
		await writeFile(join(cwd, "wide"), "漢".repeat(60_000));
		const result = await readTool.execute({ path: "wide" }, { cwd });
		expect(result.ok).toBe(true);
		expect(result.truncated).toBe(true);
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(51_200);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

it.each(['"x".repeat(60000)+"END\\n"', '"x\\n".repeat(60000)+"END\\n"'])(
	"S5: preserves the bash tail: %s",
	async (expression) => {
		const cwd = await mkdtemp(join(tmpdir(), "atelier-regression-"));
		try {
			const command = `${JSON.stringify(process.execPath)} -e 'process.stdout.write(${expression})'`;
			const result = await bashTool.execute({ command }, { cwd });
			expect(result.ok).toBe(true);
			expect(result.truncated).toBe(true);
			expect(result.output).toContain("END");
			expect(await readFile(result.fullOutputPath as string, "utf8")).toMatch(/END\n$/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	},
);
