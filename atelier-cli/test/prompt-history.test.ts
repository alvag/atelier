import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PROMPT_HISTORY_LIMIT, PromptHistory } from "../src/tui/prompt-history.ts";

let home: string;
let cwd: string;

beforeEach(async () => {
	home = await mkdtemp(join(fileURLToPath(new URL("../../", import.meta.url)), ".test-history-"));
	cwd = join(home, "project");
	await mkdir(cwd);
});
afterEach(async () => {
	vi.restoreAllMocks();
	await rm(home, { recursive: true, force: true });
});

const root = () => join(home, ".atelier", "prompt-history");
async function files(): Promise<string[]> {
	const [project] = await readdir(root());
	return project ? (await readdir(join(root(), project))).sort() : [];
}
const open = (dir = cwd, warnings: string[] = []) => PromptHistory.open(home, dir, (m) => warnings.push(m));

it("remembers prompts across opens, trimmed and oldest first", async () => {
	const first = await open();
	await first.add("  one \n");
	await first.add("two");
	expect([...(await open()).entries]).toEqual(["one", "two"]);
});

it("orders new submissions after the loaded history even within the same millisecond", async () => {
	vi.spyOn(Date, "now").mockReturnValue(1730000000000);
	const first = await open();
	await first.add("one");
	await first.add("two");
	await (await open()).add("three");
	expect((await open()).entries).toEqual(["one", "two", "three"]);
});

it("tightens existing history directory permissions", async () => {
	await (await open()).add("private");
	const [project] = await readdir(root());
	const dir = join(root(), project as string);
	await chmod(root(), 0o755);
	await chmod(dir, 0o755);
	await open();
	expect((await stat(root())).mode & 0o777).toBe(0o700);
	expect((await stat(dir)).mode & 0o777).toBe(0o700);
});

it("refuses a symlinked Atelier base without writing through it", async () => {
	const elsewhere = join(home, "elsewhere");
	await mkdir(elsewhere);
	await symlink(elsewhere, join(home, ".atelier"));
	const warnings: string[] = [];
	await (await open(cwd, warnings)).add("private");
	expect(warnings).toHaveLength(1);
	expect(await readdir(elsewhere)).toEqual([]);
});

it("does not let a failed warning callback break startup", async () => {
	await writeFile(join(home, ".atelier"), "not a directory");
	const history = await PromptHistory.open(home, cwd, () => {
		throw new Error("renderer unavailable");
	});
	await expect(history.add("still usable")).resolves.toBeUndefined();
	expect(history.entries).toEqual(["still usable"]);
});

it.each(["base", "root", "project"])("refuses a %s directory replaced by a symlink after open", async (level) => {
	const warnings: string[] = [];
	const history = await open(cwd, warnings);
	const [project] = await readdir(root());
	const path = level === "base" ? join(home, ".atelier") : level === "root" ? root() : join(root(), project as string);
	const elsewhere = join(home, "elsewhere");
	const target = join(
		elsewhere,
		level === "base" ? "prompt-history" : "",
		level === "project" ? "" : (project as string),
	);
	await mkdir(target, { recursive: true });
	await rm(path, { recursive: true });
	await symlink(elsewhere, path);
	await history.add("must stay private");
	expect(warnings).toHaveLength(1);
	expect(history.entries).toEqual(["must stay private"]);
	expect(await readdir(target)).toEqual([]);
});

it("keeps the latest occurrence of a repeated prompt and drops its older files", async () => {
	const history = await open();
	for (const text of ["a", "b", " a"]) await history.add(text);
	expect([...(await open()).entries]).toEqual(["b", "a"]);
	expect(await files()).toHaveLength(2);
});

it("keeps only the latest 100 distinct prompts", async () => {
	const history = await open();
	for (let i = 0; i < PROMPT_HISTORY_LIMIT + 5; i++) await history.add(`p${i}`);
	const entries = [...(await open()).entries];
	expect(entries).toHaveLength(PROMPT_HISTORY_LIMIT);
	expect(entries[0]).toBe("p5");
	expect(entries.at(-1)).toBe(`p${PROMPT_HISTORY_LIMIT + 4}`);
	expect(await files()).toHaveLength(PROMPT_HISTORY_LIMIT);
});

it("ignores blank prompts and prompts over 64 KiB of UTF-8", async () => {
	const history = await open();
	await history.add("  \n");
	await history.add("é".repeat(32 * 1024 + 1));
	await history.add("é".repeat(32 * 1024));
	expect(history.entries).toHaveLength(1);
	expect(await files()).toHaveLength(1);
});

it("separates projects and treats a symlink to a project as the same one", async () => {
	const other = join(home, "other");
	const link = join(home, "link");
	await mkdir(other);
	await symlink(cwd, link);
	await (await open()).add("mine");
	await (await open(other)).add("theirs");
	expect([...(await open(link)).entries]).toEqual(["mine"]);
	expect([...(await open(other)).entries]).toEqual(["theirs"]);
});

it("writes immutable version 1 records with private permissions", async () => {
	await (await open()).add("hello");
	const [project] = await readdir(root());
	const dir = join(root(), project as string);
	const [name] = await files();
	expect((await stat(root())).mode & 0o777).toBe(0o700);
	expect((await stat(dir)).mode & 0o777).toBe(0o700);
	expect((await stat(join(dir, name as string))).mode & 0o777).toBe(0o600);
	expect(JSON.parse(await readFile(join(dir, name as string), "utf8"))).toEqual({
		version: 1,
		createdAt: expect.any(Number),
		text: "hello",
	});
});

it("skips corrupt, unknown-version and malformed records without failing", async () => {
	await (await open()).add("good");
	const [project] = await readdir(root());
	const dir = join(root(), project as string);
	const bad = (n: number, body: string) =>
		writeFile(join(dir, `${String(n).padStart(15, "0")}-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.json`), body);
	await bad(1, "{nope");
	await bad(2, JSON.stringify({ version: 2, createdAt: 1, text: "future" }));
	await bad(3, JSON.stringify({ version: 1, createdAt: "x", text: "typed" }));
	await bad(4, JSON.stringify({ version: 1, createdAt: 1, text: 7 }));
	const warnings: string[] = [];
	const history = await open(cwd, warnings);
	expect([...history.entries]).toEqual(["good"]);
	expect(warnings).toEqual([]);
});

it("falls back to memory and warns once when storage is a symlink or unwritable", async () => {
	await mkdir(join(home, ".atelier"));
	await mkdir(join(home, "elsewhere"));
	await symlink(join(home, "elsewhere"), root());
	const warnings: string[] = [];
	const history = await open(cwd, warnings);
	await history.add("kept in memory");
	await history.add("again");
	expect([...history.entries]).toEqual(["kept in memory", "again"]);
	expect(warnings).toHaveLength(1);
	expect(await readdir(join(home, "elsewhere"))).toEqual([]);
});

it("refuses a symlinked project directory and a symlinked record", async () => {
	await (await open()).add("real");
	const [project] = await readdir(root());
	const dir = join(root(), project as string);
	const [name] = await files();
	await writeFile(join(home, "outside.json"), JSON.stringify({ version: 1, createdAt: 9e12, text: "outside" }));
	await symlink(
		join(home, "outside.json"),
		join(dir, `${"9".repeat(15)}-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.json`),
	);
	expect([...(await open()).entries]).toEqual(["real"]);
	await rm(dir, { recursive: true });
	await symlink(join(home, "project"), dir);
	const warnings: string[] = [];
	expect([...(await open(cwd, warnings)).entries]).toEqual([]);
	expect(warnings).toHaveLength(1);
	expect(name).toBeDefined();
});

it.skipIf(process.platform === "win32")(
	"ignores a named pipe instead of blocking startup",
	async () => {
		await (await open()).add("good");
		const [project] = await readdir(root());
		const dir = join(root(), project as string);
		execFileSync("mkfifo", [join(dir, `000000000000001-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.json`)]);
		const module = pathToFileURL(fileURLToPath(new URL("../src/tui/prompt-history.ts", import.meta.url))).href;
		const script = `import { PromptHistory } from ${JSON.stringify(module)};
const history = await PromptHistory.open(${JSON.stringify(home)}, ${JSON.stringify(cwd)});
if (history.entries.join() !== "good") process.exit(1);`;
		const code = await new Promise<number | null>((done, reject) => {
			spawn(process.execPath, ["--input-type=module", "-e", script], { timeout: 5000 })
				.on("error", reject)
				.on("close", done);
		});
		expect(code).toBe(0);
	},
	15000,
);

it.each([10, 30])(
	"retains concurrent processes' latest prompts with %i writes each",
	async (count) => {
		const script = join(home, "writer.ts");
		const module = pathToFileURL(fileURLToPath(new URL("../src/tui/prompt-history.ts", import.meta.url))).href;
		await writeFile(
			script,
			`import { PromptHistory } from ${JSON.stringify(module)};
const [home, cwd, tag, count] = process.argv.slice(2);
const history = await PromptHistory.open(home, cwd);
for (let i = 0; i < Number(count); i++) await history.add(tag + i);
`,
		);
		const run = (tag: string) =>
			new Promise<number | null>((done) =>
				spawn(process.execPath, [script, home, cwd, tag, String(count)], { stdio: "inherit" }).on("close", done),
			);
		expect(await Promise.all(["a", "b", "c", "d"].map(run))).toEqual([0, 0, 0, 0]);
		const entries = [...(await open()).entries];
		expect(entries).toHaveLength(Math.min(100, 4 * count));
		expect(new Set(entries).size).toBe(entries.length);
		for (const tag of ["a", "b", "c", "d"]) expect(entries).toContain(`${tag}${count - 1}`);
		const a = entries.filter((e) => e.startsWith("a"));
		expect(a).toEqual([...a].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))));
		expect(await files()).toHaveLength(entries.length);
	},
	30000,
);
