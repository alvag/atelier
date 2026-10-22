/**
 * Smoke test of the built desktop app: launches Electron with Playwright,
 * opens a session, runs a turn and answers an approval, then quits and
 * checks that no core process is left running.
 *
 *   pnpm -C atelier-desktop smoke            # echo backend, no network
 *   ATELIER_E2E_REAL=1 pnpm -C atelier-desktop smoke -- <folder> "<prompt>"
 *                                           # real Claude Code run (uses your subscription)
 *   ATELIER_E2E_REAL=1 ATELIER_E2E_BACKEND=anthropic-api pnpm -C atelier-desktop smoke -- <folder> "<prompt>"
 *                                           # real run on the API key from the Keychain (costs money)
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, type Page } from "@playwright/test";

const appDir = dirname(dirname(fileURLToPath(import.meta.url)));
const real = process.env.ATELIER_E2E_REAL === "1";
const [folderArg, promptArg] = process.argv.slice(2);
const shots = process.env.ATELIER_E2E_SHOTS;
const backend = process.env.ATELIER_E2E_BACKEND ?? "claude-code";

function coreProcesses(): number {
	const lines = execFileSync("ps", ["-Ao", "command"], { encoding: "utf8" }).split("\n");
	return lines.filter((line) => line.includes("src/server/main.ts serve")).length;
}

async function shot(page: Page, name: string) {
	if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

const folder = folderArg ?? (await mkdtemp(join(tmpdir(), "atelier-smoke-")));
const before = coreProcesses();
const app = await electron.launch({
	args: [join(appDir, "out/main/index.js")],
	env: { ...process.env, ATELIER_E2E_FOLDER: folder, ...(real ? {} : { ATELIER_BACKEND: "echo" }) },
});
try {
	const page = await app.firstWindow();
	await page.getByText(/^core \d/).waitFor({ timeout: 15_000 });
	await page.getByLabel("backend").selectOption(backend);
	await page.getByRole("button", { name: "Open folder…" }).click();
	await page.getByText(folder).waitFor();

	const send = async (prompt: string) => {
		await page.getByLabel("Prompt").fill(prompt);
		await page.getByLabel("Prompt").press("Enter");
	};

	if (!real) {
		await send("hello");
		await page.getByText("echo: hello").waitFor();
		await page
			.getByText(/^tokens: input 0/)
			.first()
			.waitFor();

		await send("bash: echo smoke-ok");
		await page.getByRole("button", { name: "Allow" }).click();
		await page.getByText("echo smoke-ok (exit 0)").waitFor();
		await page.getByText("bash ok").waitFor();
		await shot(page, "smoke");
		console.log("smoke: turn streamed, approval answered, tool ran");
	} else {
		await send(promptArg ?? "Reply with the single word: ready");
		// Allow every command the agent asks for until the turn ends.
		// The parent's own token line, not a subagent's (those sit inside .subagent blocks).
		const finished = page.locator("section.turn > .tokens");
		while (!(await finished.isVisible())) {
			const allow = page.getByRole("button", { name: "Allow" });
			if (await allow.isVisible()) await allow.first().click();
			await page.waitForTimeout(500);
		}
		await shot(page, "real");
		const status = await page.getByRole("status").textContent();
		const tokens = await finished.first().textContent();
		const tools = await page.getByTestId("tool-row").allTextContents();
		const subagents = await page.getByTestId("subagent").count();
		const panel = page.getByRole("complementary", { name: "Feature" });
		const feature = (await panel.count()) > 0 ? await panel.textContent() : null;
		console.log(JSON.stringify({ status, tokens, tools, subagents, feature }, null, 2));
		if (backend === "anthropic-api")
			assert.ok(status?.includes("billed to your Anthropic API key"), `not on the API key: ${status}`);
		else assert.ok(!status?.includes("not using a Claude subscription"), "the session is not on the subscription");
		assert.ok(!status?.includes("error"), `status bar shows an error: ${status}`);
	}
} finally {
	await app.close();
	if (!folderArg) await rm(folder, { recursive: true, force: true });
}

// The core must not outlive the app.
await new Promise((resolve) => setTimeout(resolve, 500));
assert.equal(coreProcesses(), before, "a core process is still running after the app closed");
console.log("smoke: app closed and its core exited");
