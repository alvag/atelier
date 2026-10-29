// @vitest-environment happy-dom
import type { AtelierEventBody, ClientCommand } from "@atelier/core/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/renderer/src/App.tsx";
import type { AtelierBridge, CommandResult, CoreStatus, HostMessage } from "../src/shared/bridge.ts";

afterEach(cleanup);

/** In-memory bridge: records commands, answers them with `answers`, and lets the test push host messages. */
function fakeBridge(status: CoreStatus = { type: "core_ready", version: "0.0.0" }) {
	const commands: ClientCommand[] = [];
	/** `profiles.list` requests, kept apart: the selector asks for them on its own. */
	const listed: ClientCommand[] = [];
	const listeners = new Set<(message: HostMessage) => void>();
	let seq = 0;
	const answers: Partial<Record<ClientCommand["command"], CommandResult>> = {
		"session.start": { ok: true, result: { sessionId: "s1" } },
		"session.send": { ok: true, result: { turnId: "t1" } },
		"profiles.list": { ok: true, result: { profiles: [] } },
	};
	const bridge: AtelierBridge = {
		request: async (command) => {
			(command.command === "profiles.list" ? listed : commands).push(command);
			return answers[command.command] ?? { ok: true, result: {} };
		},
		onMessage: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		restartCore: async () => {
			commands.push({ command: "shutdown" });
		},
		getStatus: async () => status,
		pickFolder: async () => "/work",
	};
	const push = (message: HostMessage) =>
		act(() => {
			for (const listener of listeners) listener(message);
		});
	const emit = (body: AtelierEventBody) =>
		push({ type: "event", sessionId: "s1", event: { ...body, seq: ++seq, turnId: "t1" } as never });
	return { bridge, commands, listed, answers, push, emit };
}

async function openFolderAndSend(fake: ReturnType<typeof fakeBridge>, prompt: string) {
	render(<App bridge={fake.bridge} />);
	await screen.findByText("core 0.0.0");
	fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
	await screen.findByText("/work");
	const box = screen.getByLabelText("Prompt");
	fireEvent.change(box, { target: { value: prompt } });
	fireEvent.keyDown(box, { key: "Enter" });
	await waitFor(() => expect(fake.commands.at(-1)?.command).toBe("session.send"));
}

describe("App", () => {
	it("shows the core status it asks for after subscribing", async () => {
		render(<App bridge={fakeBridge({ type: "core_failed", message: "spawn ENOENT" }).bridge} />);
		expect(await screen.findByText("core failed to start")).toBeTruthy();
		expect(screen.getByText("core_failed: spawn ENOENT")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Restart core" })).toBeTruthy();
	});

	it("opens a session in the picked folder with the chosen model and sends the prompt", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "add validation");
		expect(fake.commands).toEqual([
			{ command: "session.start", cwd: "/work", model: "opus", backend: "claude-code", userQuestions: true },
			{ command: "session.send", sessionId: "s1", prompt: "add validation" },
		]);
		expect(screen.getByText("add validation")).toBeTruthy();
		expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("");
	});

	it("lists the profiles once the core is ready and starts the session with the chosen one", async () => {
		const fake = fakeBridge();
		fake.answers["profiles.list"] = { ok: true, result: { profiles: ["cheap", "deep"], active: "deep" } };
		render(<App bridge={fake.bridge} />);
		await screen.findByText("core 0.0.0");
		const select = (await screen.findByLabelText("profile")) as HTMLSelectElement;
		await waitFor(() => expect([...select.options].map((option) => option.value)).toEqual(["", "cheap", "deep"]));
		expect(select.options[0]?.textContent).toBe("by layers (active: deep)");
		expect(fake.listed).toEqual([{ command: "profiles.list" }]);
		fireEvent.change(select, { target: { value: "cheap" } });
		fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
		await waitFor(() =>
			expect(fake.commands).toEqual([
				{
					command: "session.start",
					cwd: "/work",
					model: "opus",
					backend: "claude-code",
					userQuestions: true,
					profile: "cheap",
				},
			]),
		);
	});

	it("sends no profile once the chosen one is gone from the list the restarted core answers", async () => {
		const fake = fakeBridge();
		fake.answers["profiles.list"] = { ok: true, result: { profiles: ["cheap", "deep"] } };
		render(<App bridge={fake.bridge} />);
		await screen.findByText("core 0.0.0");
		const select = (await screen.findByLabelText("profile")) as HTMLSelectElement;
		await waitFor(() => expect(select.options).toHaveLength(3));
		fireEvent.change(select, { target: { value: "cheap" } });
		fake.answers["profiles.list"] = { ok: true, result: { profiles: ["deep"] } };
		await fake.push({ type: "core_exited", message: "exit 1" });
		await fake.push({ type: "core_ready", version: "0.0.1" });
		await waitFor(() => expect(fake.listed).toHaveLength(2));
		await waitFor(() => expect((screen.getByLabelText("profile") as HTMLSelectElement).value).toBe(""));
		fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
		await waitFor(() =>
			expect(fake.commands).toEqual([
				{ command: "session.start", cwd: "/work", model: "opus", backend: "claude-code", userQuestions: true },
			]),
		);
	});

	it("sends no profile when the list the core answers fails", async () => {
		const fake = fakeBridge();
		fake.answers["profiles.list"] = { ok: true, result: { profiles: ["cheap"] } };
		render(<App bridge={fake.bridge} />);
		await screen.findByText("core 0.0.0");
		const select = (await screen.findByLabelText("profile")) as HTMLSelectElement;
		await waitFor(() => expect(select.options).toHaveLength(2));
		fireEvent.change(select, { target: { value: "cheap" } });
		fake.answers["profiles.list"] = { ok: false, error: { code: "boom", message: "x" } };
		await fake.push({ type: "core_exited", message: "exit 1" });
		await fake.push({ type: "core_ready", version: "0.0.1" });
		await waitFor(() => expect(fake.listed).toHaveLength(2));
		await waitFor(() => expect(screen.queryByLabelText("profile")).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
		await waitFor(() =>
			expect(fake.commands).toEqual([
				{ command: "session.start", cwd: "/work", model: "opus", backend: "claude-code", userQuestions: true },
			]),
		);
	});

	it("has no profile selector without profiles", async () => {
		const fake = fakeBridge();
		render(<App bridge={fake.bridge} />);
		await screen.findByText("core 0.0.0");
		await waitFor(() => expect(fake.listed).toHaveLength(1));
		expect(screen.queryByLabelText("profile")).toBeNull();
	});

	it("shows the session's profile, its origin and its effort in the status bar", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({
			type: "session_started",
			backend: "claude-code",
			model: "opus",
			authSource: "subscription",
			effort: "high",
			profile: {
				name: "cheap",
				origin: "repo",
				roles: { verifier: { backend: "anthropic-api", model: "claude-sonnet-5-5", thinking: "medium" } },
			},
		});
		const status = screen.getByRole("status");
		const profile = await within(status).findByText("profile: cheap (repo)");
		expect(profile.getAttribute("title")).toBe("verifier: anthropic-api/claude-sonnet-5-5 thinking medium");
		expect(within(status).getByText("opus · effort high")).toBeTruthy();
		fake.emit({
			type: "session_started",
			backend: "claude-code",
			model: "opus",
			authSource: "subscription",
			profile: { origin: "default", roles: {} },
		});
		expect(await within(status).findByText("profile: default")).toBeTruthy();
	});

	it("sends the chosen mode with session.start, and none for the default", async () => {
		const fake = fakeBridge();
		render(<App bridge={fake.bridge} />);
		await screen.findByText("core 0.0.0");
		const select = screen.getByLabelText("mode") as HTMLSelectElement;
		expect(select.value).toBe("");
		expect(
			within(select)
				.getAllByRole("option")
				.map((option) => option.textContent),
		).toEqual(["default", "normal", "auto", "yolo"]);
		fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
		await waitFor(() => expect(fake.commands).toHaveLength(1));
		expect(fake.commands[0]).toEqual({
			command: "session.start",
			cwd: "/work",
			model: "opus",
			backend: "claude-code",
			userQuestions: true,
		});

		fireEvent.change(select, { target: { value: "auto" } });
		fireEvent.click(screen.getByRole("button", { name: "New session…" }));
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.start",
				cwd: "/work",
				model: "opus",
				backend: "claude-code",
				userQuestions: true,
				mode: "auto",
			}),
		);
	});

	it("explains auto in a tooltip on its option, in the toolbar and in the status bar", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({
			type: "session_started",
			backend: "claude-code",
			model: "opus",
			authSource: "subscription",
			permissionMode: "normal",
		});
		await within(screen.getByRole("status")).findByLabelText("session mode");
		const autos = screen.getAllByRole("option", { name: "auto" });
		expect(autos).toHaveLength(2);
		for (const option of autos)
			expect(option.getAttribute("title")).toBe("auto: a classifier model decides what normal would ask");
		expect(screen.getAllByRole("option", { name: "normal" })[0]?.hasAttribute("title")).toBe(false);
	});

	it("shows the session's mode in the status bar and changes it with session.set_mode", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({
			type: "session_started",
			backend: "claude-code",
			model: "opus",
			authSource: "subscription",
			permissionMode: "normal",
		});
		const status = screen.getByRole("status");
		const select = (await within(status).findByLabelText("session mode")) as HTMLSelectElement;
		expect(select.value).toBe("normal");
		expect(select.className).not.toContain("warning");

		fake.answers["session.set_mode"] = { ok: true, result: { mode: "yolo" } };
		fireEvent.change(select, { target: { value: "yolo" } });
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({ command: "session.set_mode", sessionId: "s1", mode: "yolo" }),
		);
		await waitFor(() =>
			expect((within(status).getByLabelText("session mode") as HTMLSelectElement).value).toBe("yolo"),
		);
		expect(within(status).getByLabelText("session mode").className).toContain("warning");
	});

	it("keeps the previous mode and shows the error when session.set_mode fails", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({
			type: "session_started",
			backend: "claude-code",
			model: "opus",
			authSource: "subscription",
			permissionMode: "auto",
		});
		const status = screen.getByRole("status");
		const select = (await within(status).findByLabelText("session mode")) as HTMLSelectElement;
		fake.answers["session.set_mode"] = { ok: false, error: { code: "unknown_session", message: "No such session" } };
		fireEvent.change(select, { target: { value: "yolo" } });
		expect(await within(status).findByText("unknown_session: No such session")).toBeTruthy();
		expect((within(status).getByLabelText("session mode") as HTMLSelectElement).value).toBe("auto");
	});

	it("shows a permission_mode_invalid error like any recoverable error", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "error", code: "permission_mode_invalid", message: "default file is broken", recoverable: true });
		expect(await screen.findByText("permission_mode_invalid: default file is broken")).toBeTruthy();
	});

	it("streams text, shows tool rows and the turn's tokens", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "text_delta", text: "Hello **there**" });
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "read", input: { path: "a.ts" } });
		fake.emit({ type: "tool_call_finished", callId: "c1", ok: true, summary: "a.ts (3 lines)", truncated: false });
		fake.emit({
			type: "turn_finished",
			stopReason: "end_turn",
			usage: { input: 1200, output: 85, cacheRead: 9000, cacheWrite: 3100 },
			costUsd: 0.0421,
		});
		expect((await screen.findByText("there")).tagName).toBe("STRONG");
		expect(screen.getByTestId("tool-row").textContent).toContain("a.ts (3 lines)");
		expect(
			screen.getByText("tokens: input 1,200 · output 85 · cache read 9,000 · cache write 3,100 · cache 68%"),
		).toBeTruthy();
	});

	it("shows claude-code's default alias as the model it stands for, and starts the session on the alias", async () => {
		const fake = fakeBridge();
		render(<App bridge={fake.bridge} />);
		await screen.findByText("core 0.0.0");
		const model = screen.getByLabelText("model") as HTMLSelectElement;
		expect(model.value).toBe("claude-opus-5-5");
		fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
		await waitFor(() =>
			expect(fake.commands).toEqual([
				{ command: "session.start", cwd: "/work", model: "opus", backend: "claude-code", userQuestions: true },
			]),
		);
	});

	it("opens an anthropic-api session with that backend's models and says it bills the API key", async () => {
		const fake = fakeBridge();
		render(<App bridge={fake.bridge} />);
		await screen.findByText("core 0.0.0");
		fireEvent.change(screen.getByLabelText("backend"), { target: { value: "anthropic-api" } });
		const model = screen.getByLabelText("model") as HTMLSelectElement;
		expect([...model.options].map((option) => option.value)).toEqual([
			"claude-sonnet-5-5",
			"claude-opus-5-5",
			"claude-haiku-5-5",
		]);
		expect(model.value).toBe("claude-sonnet-5-5");
		fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
		await waitFor(() =>
			expect(fake.commands).toEqual([
				{
					command: "session.start",
					cwd: "/work",
					model: "claude-sonnet-5-5",
					backend: "anthropic-api",
					userQuestions: true,
				},
			]),
		);
		fake.emit({ type: "session_started", backend: "anthropic-api", model: "claude-sonnet-5-5", authSource: "api_key" });
		expect(await screen.findByText("billed to your Anthropic API key")).toBeTruthy();
		expect(screen.queryByText(/not using a Claude subscription/)).toBeNull();
	});

	it("sums up a finished turn in one line and folds the token breakdown under it", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({
			type: "session_started",
			backend: "claude-code",
			model: "claude-opus-5-5",
			authSource: "subscription",
		});
		fake.emit({
			type: "turn_finished",
			stopReason: "end_turn",
			usage: { input: 1200, output: 85, cacheRead: 45_000, cacheWrite: 1900 },
			costUsd: 0.0312,
			durationMs: 72_400,
		});
		const usage = await screen.findByTestId("usage");
		expect(usage.tagName).toBe("DETAILS");
		expect(usage.hasAttribute("open")).toBe(false);
		expect(usage.querySelector("summary")?.textContent).toBe("claude-opus-5-5 · 1m 12s · 48.2K tokens · $0.0312");
		expect(usage.querySelector(".tokens")?.textContent).toBe(
			"tokens: input 1,200 · output 85 · cache read 45,000 · cache write 1,900 · cache 94%",
		);
	});

	it("lists the turn's cost by phase inside the folded breakdown", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		const part = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
		fake.emit({
			type: "turn_finished",
			stopReason: "end_turn",
			usage: part(3500),
			costUsd: 0.05,
			requests: 4,
			phases: {
				main: { usage: part(3000), requests: 1, costUsd: 0.05 },
				lenses: { usage: part(500), requests: 3 },
			},
		});
		const usage = await screen.findByTestId("usage");
		expect([...usage.querySelectorAll(".phases li")].map((li) => li.textContent)).toEqual([
			"main · 3K tokens · 1 request · $0.0500",
			"lenses · 500 tokens · 3 requests",
		]);
	});

	it("says who ran in each phase, with the effort asked or the one the backend applied", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({
			type: "session_started",
			backend: "claude-code",
			model: "claude-opus-5-5",
			authSource: "subscription",
		});
		const part = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
		fake.emit({
			type: "turn_finished",
			stopReason: "end_turn",
			usage: part(3200),
			phases: {
				main: {
					usage: part(3000),
					requests: 1,
					agents: [
						{ role: "orchestrator", backend: "claude-code", model: "claude-opus-5-5", effectiveEffort: "xhigh" },
					],
				},
				verify: {
					usage: part(200),
					requests: 1,
					agents: [{ role: "verifier", backend: "codex", model: "gpt-5.5", effort: "medium" }],
				},
			},
		});
		const usage = await screen.findByTestId("usage");
		expect([...usage.querySelectorAll(".phases li")].map((li) => li.textContent)).toEqual([
			"main · 3K tokens · 1 request · on claude-opus-5-5 effective xhigh",
			"verify · 200 tokens · 1 request · on codex/gpt-5.5 medium",
		]);
	});

	it("lists the classifier's cost as its own phase", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		const part = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
		fake.emit({
			type: "turn_finished",
			stopReason: "end_turn",
			usage: part(3200),
			phases: {
				main: { usage: part(3000), requests: 1 },
				classifier: { usage: part(200), requests: 2, costUsd: 0.001 },
			},
		});
		const usage = await screen.findByTestId("usage");
		expect([...usage.querySelectorAll(".phases li")].map((li) => li.textContent)).toEqual([
			"main · 3K tokens · 1 request",
			"classifier · 200 tokens · 2 requests · $0.0010",
		]);
	});

	it("shows what the classifier decided on the tool row, its reason as plain text", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "ls" } });
		fake.emit({ type: "permission_classified", callId: "c1", decision: "allow", reason: "reads <b>only</b>" });
		fake.emit({ type: "tool_call_started", callId: "c2", tool: "bash", input: { command: "rm x" } });
		fake.emit({ type: "permission_classified", callId: "c2", decision: "deny", reason: "not asked for" });
		fake.emit({ type: "tool_call_started", callId: "c3", tool: "bash", input: { command: "make" } });
		fake.emit({
			type: "permission_classified",
			callId: "c3",
			decision: "undecided",
			reason: "classifier unavailable: timeout",
		});
		await waitFor(() => expect(screen.getAllByTestId("tool-row")).toHaveLength(3));
		const [allowed, denied, undecided] = screen.getAllByTestId("tool-row");
		expect(allowed?.textContent).toContain("auto: allowed — reads <b>only</b>");
		expect(allowed?.querySelector("b")).toBeNull();
		expect(denied?.textContent).toContain("auto: denied — not asked for");
		expect(denied?.querySelector(".warning")?.textContent).toContain("auto: denied");
		expect(allowed?.querySelector(".warning")).toBeNull();
		expect(undecided?.textContent).toContain("auto: undecided — classifier unavailable: timeout; asking you");
	});

	it("lists no phases for a turn with only the main agent, which the total already says", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		const usage = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 };
		fake.emit({ type: "turn_finished", stopReason: "end_turn", usage, phases: { main: { usage } } });
		expect((await screen.findByTestId("usage")).querySelector(".phases")).toBeNull();
	});

	it("labels each finished turn with the model it ran on, not the current one", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		const finish = () =>
			fake.emit({
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			});
		fake.emit({
			type: "session_started",
			backend: "claude-code",
			model: "claude-opus-5-5",
			authSource: "subscription",
		});
		finish();
		await screen.findByTestId("usage");
		fake.emit({
			type: "session_started",
			backend: "claude-code",
			model: "claude-haiku-5-5",
			authSource: "subscription",
		});
		await waitFor(() =>
			expect(screen.getAllByTestId("usage").map((usage) => usage.querySelector("summary")?.textContent)).toEqual([
				"claude-opus-5-5 · 2 tokens",
			]),
		);
	});

	it("shows why the cache missed and how many requests the turn made", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "cache_miss", reason: "system_changed", missedTokens: 4200 });
		fake.emit({
			type: "turn_finished",
			stopReason: "end_turn",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
			requests: 3,
		});
		expect(await screen.findByText("cache miss: system_changed · 4,200 tokens not read from the cache")).toBeTruthy();
		expect(
			screen.getByText("tokens: input 100 · output 10 · cache read 0 · cache write 0 · cache 0% · 3 requests"),
		).toBeTruthy();
	});

	it("shows a subagent's work in a block under its task call, with its own tokens and approvals", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		const child = (body: Record<string, unknown>) =>
			fake.emit({ ...body, parentCallId: "c1", agent: "worker" } as unknown as AtelierEventBody);
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "task", input: { agent: "worker", prompt: "Fix it." } });
		child({ type: "session_started", backend: "claude-code", model: "opus", authSource: "subscription" });
		child({ type: "tool_call_started", callId: "r1", tool: "read", input: { path: "a.ts" } });
		child({ type: "tool_call_finished", callId: "r1", ok: true, summary: "a.ts (3 lines)", truncated: false });
		child({ type: "approval_requested", callId: "b1", command: "npm test" });
		const block = await screen.findByTestId("subagent");
		expect(block.textContent).toContain("worker · opus");
		expect(block.textContent).toContain("a.ts (3 lines)");
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.approve",
				sessionId: "s1",
				callId: "b1",
				approved: true,
			}),
		);
		child({
			type: "turn_finished",
			stopReason: "end_turn",
			usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 0 },
			requests: 2,
		});
		expect(
			await screen.findByText("tokens: input 10 · output 2 · cache read 30 · cache write 0 · cache 75% · 2 requests"),
		).toBeTruthy();
		// The parent's composer stays busy, queueing, until the parent's own turn ends.
		expect(screen.getByRole("button", { name: "Queue" })).toBeTruthy();
	});

	it("shows the memory in the status bar, or why there is none", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "memory_status", available: true, project: "atelier" });
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("memory: atelier"));
		fake.emit({ type: "memory_status", available: false, reason: "Engram is not installed" });
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("no memory"));
		expect(screen.getByTitle("Engram is not installed")).toBeTruthy();
	});

	it("shows the instruction files in the status bar, and warns about those the cap left out", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "project_instructions", files: ["/w/AGENTS.md"], dropped: ["/AGENTS.md"] });
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("instructions: 1"));
		expect(screen.getByRole("status").textContent).toContain("instructions over 32 KiB: 1 left out");
		expect(screen.getByTitle("/AGENTS.md")).toBeTruthy();
	});

	it("shows the skills in the status bar, and warns about those with a problem", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({
			type: "skills_loaded",
			skills: [
				{ name: "pdf", path: "/w/.agents/skills/pdf/SKILL.md" },
				{ name: "notes", path: "/h/.agents/skills/notes/SKILL.md" },
			],
			warnings: [{ path: "/w/.agents/skills/x/SKILL.md", message: "no description; not loaded" }],
		});
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("skills: 2"));
		expect(
			screen.getByTitle(
				/^pdf\s+\/w\/\.agents\/skills\/pdf\/SKILL\.md\s+notes\s+\/h\/\.agents\/skills\/notes\/SKILL\.md$/,
			),
		).toBeTruthy();
		expect(screen.getByRole("status").textContent).toContain("skills: 1 warning");
		expect(screen.getByTitle("/w/.agents/skills/x/SKILL.md: no description; not loaded")).toBeTruthy();
	});

	it("shows the phase in the status bar and the feature's tasks in a panel", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "phase_changed", phase: "implementing", source: "inferred" });
		fake.emit({
			type: "feature_changed",
			name: "slug-accents",
			path: "odd/tasks/slug-accents.md",
			title: "Slug accents",
			tasks: [
				{ id: "T1", title: "Transliterate", specs: ["S1"], status: "done", commit: "abc1234" },
				{ id: "T2", title: "Run the tests", specs: ["S1"], status: "in_progress" },
			],
		});
		// Host messages are applied once per frame: wait for the batch, not just for the status bar.
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("implementing"));
		const panel = await screen.findByRole("complementary", { name: "Feature" });
		expect(panel.textContent).toContain("Slug accents");
		expect(panel.textContent).toContain("odd/tasks/slug-accents.md");
		expect(panel.textContent).toContain("1/2 done");
		const rows = screen.getAllByTestId("feature-task").map((row) => row.textContent);
		expect(rows).toEqual(["✓T1Transliterateabc1234", "▸T2Run the tests"]);
	});

	it("queues a steer with Enter and a follow-up with Alt+Enter while a turn runs, and edits or removes them", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "go");
		const box = screen.getByLabelText("Prompt");
		fireEvent.change(box, { target: { value: "use tabs" } });
		fireEvent.keyDown(box, { key: "Enter" });
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.queue",
				sessionId: "s1",
				kind: "steer",
				text: "use tabs",
			}),
		);
		expect((box as HTMLTextAreaElement).value).toBe("");
		fireEvent.change(box, { target: { value: "then docs" } });
		fireEvent.keyDown(box, { key: "Enter", altKey: true });
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.queue",
				sessionId: "s1",
				kind: "follow_up",
				text: "then docs",
			}),
		);
		fake.emit({
			type: "queue_update",
			messages: [
				{ id: "q1", kind: "steer", text: "use tabs" },
				{ id: "q2", kind: "follow_up", text: "then docs" },
			],
		});
		const queue = await screen.findByRole("list", { name: "Queued messages" });
		expect(within(queue).getByText("steer")).toBeTruthy();
		expect(within(queue).getByText("follow-up")).toBeTruthy();

		fireEvent.click(within(queue).getByRole("button", { name: "Remove use tabs" }));
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({ command: "session.unqueue", sessionId: "s1", messageId: "q1" }),
		);
		fireEvent.click(within(queue).getByRole("button", { name: "Edit then docs" }));
		const editing = within(queue).getByLabelText("Queued message");
		fireEvent.change(editing, { target: { value: "then the docs" } });
		fireEvent.click(within(queue).getByRole("button", { name: "Save" }));
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.queue_edit",
				sessionId: "s1",
				messageId: "q2",
				text: "then the docs",
			}),
		);
		fake.emit({ type: "queue_update", messages: [] });
		await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
	});

	it("puts the text back in the composer when the core does not queue it", async () => {
		const fake = fakeBridge();
		fake.answers["session.queue"] = { ok: false, error: { code: "turn_ended", message: "not queued" } };
		await openFolderAndSend(fake, "go");
		const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
		fireEvent.change(box, { target: { value: "use tabs" } });
		fireEvent.keyDown(box, { key: "Enter" });
		await waitFor(() => expect(fake.commands.at(-1)?.command).toBe("session.queue"));
		await waitFor(() => expect(box.value).toBe("use tabs"));
		expect(screen.getByText("turn_ended: not queued")).toBeTruthy();
	});

	it("drops the queue with the session when the core goes away", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "go");
		fake.emit({ type: "queue_update", messages: [{ id: "q1", kind: "follow_up", text: "later" }] });
		await screen.findByRole("list", { name: "Queued messages" });
		await fake.push({ type: "core_exited", message: "exit 1" });
		await waitFor(() => expect(screen.queryByRole("list", { name: "Queued messages" })).toBeNull());
		// What was queued is not lost: it is back in the composer.
		expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("later");
	});

	it("shows a steer where it entered, a follow-up as a turn of its own, and gives an interrupted turn's queue back", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "go");
		fake.emit({ type: "queued_message", id: "q1", kind: "steer", text: "use tabs" });
		expect(await screen.findByText("use tabs")).toBeTruthy();
		fake.emit({
			type: "turn_finished",
			stopReason: "end_turn",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		});
		await waitFor(() =>
			expect((screen.getByRole("button", { name: "Interrupt" }) as HTMLButtonElement).disabled).toBe(true),
		);
		// The core starts the follow-up's turn on its own.
		fake.push({
			type: "event",
			sessionId: "s1",
			event: { type: "queued_message", id: "q2", kind: "follow_up", text: "then docs", seq: 1, turnId: "t2" },
		});
		expect(await screen.findByText("then docs")).toBeTruthy();
		expect((screen.getByRole("button", { name: "Interrupt" }) as HTMLButtonElement).disabled).toBe(false);
		const box = screen.getByLabelText("Prompt") as HTMLTextAreaElement;
		fireEvent.change(box, { target: { value: "typing" } });
		fake.push({
			type: "event",
			sessionId: "s1",
			event: {
				type: "queue_update",
				messages: [],
				returned: [
					{ id: "q3", kind: "steer", text: "a" },
					{ id: "q4", kind: "follow_up", text: "b" },
				],
				seq: 2,
				turnId: "t2",
			},
		});
		await waitFor(() => expect(box.value).toBe("a\n\nb\n\ntyping"));
	});

	it("answers an approval card through session.approve", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "rm x" } });
		fake.emit({ type: "approval_requested", callId: "c1", command: "rm x" });
		fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.approve",
				sessionId: "s1",
				callId: "c1",
				approved: false,
			}),
		);
		expect(await screen.findByText("Denied")).toBeTruthy();
	});

	it("offers to remember an approval's rules and sends the chosen one", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "ego-browser nodejs" } });
		fake.emit({
			type: "approval_requested",
			callId: "c1",
			command: "ego-browser nodejs",
			reason: "a GUI app",
			remember: { rules: ["ego-browser nodejs"], always: true },
		});
		fireEvent.click(await screen.findByRole("button", { name: 'Allow "ego-browser nodejs" always' }));
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.approve",
				sessionId: "s1",
				callId: "c1",
				approved: true,
				remember: "always",
			}),
		);
		expect(await screen.findByText("Allowed always")).toBeTruthy();

		fake.emit({ type: "tool_call_started", callId: "c2", tool: "edit", input: { path: "/tmp/notes/a.txt" } });
		fake.emit({
			type: "approval_requested",
			callId: "c2",
			command: "edit /tmp/notes/a.txt",
			reason: "outside the working directory",
			tool: "edit",
			remember: { rules: ["/tmp/notes"], always: false },
		});
		fireEvent.click(await screen.findByRole("button", { name: "Allow edits in /tmp/notes in this session" }));
		expect(screen.queryByRole("button", { name: "Allow edits in /tmp/notes always" })).toBeNull();
		await waitFor(() =>
			expect(fake.commands.at(-1)).toMatchObject({ callId: "c2", approved: true, remember: "session" }),
		);
		expect(await screen.findByText("Allowed for this session")).toBeTruthy();
	});

	it("shows the reason on an approval card that asks to leave the sandbox", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "pnpm install" } });
		fake.emit({
			type: "approval_requested",
			callId: "c1",
			command: "pnpm install",
			reason: "the install needs the network",
		});
		expect(await screen.findByText("Run this command outside the sandbox?")).toBeTruthy();
		expect(screen.getByText("the install needs the network")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(fake.commands.at(-1)).toMatchObject({ command: "session.approve", approved: true }));
	});

	it("says in the status bar whether bash is sandboxed, with the warning style when it is not", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "sandbox_status", sandboxed: true, mechanism: "macOS seatbelt" });
		const sandboxed = await screen.findByText("bash: sandboxed (macOS seatbelt)");
		expect(sandboxed.className).not.toContain("warning");

		fake.emit({ type: "sandbox_status", sandboxed: false, reason: "sandbox not available on this platform" });
		const unsandboxed = await screen.findByText("bash: not sandboxed");
		expect(unsandboxed.className).toContain("warning");
		expect(unsandboxed.getAttribute("title")).toBe(
			"sandbox not available on this platform: every command asks for approval in normal mode, and goes to the classifier in auto mode",
		);
	});

	it("starts a session without the sandbox only when the option is checked, and says so in the status bar", async () => {
		const fake = fakeBridge();
		render(<App bridge={fake.bridge} />);
		await screen.findByText("core 0.0.0");
		const option = screen.getByLabelText("run bash without the sandbox") as HTMLInputElement;
		expect(option.checked).toBe(false);
		fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
		await waitFor(() =>
			expect(fake.commands).toEqual([
				{ command: "session.start", cwd: "/work", model: "opus", backend: "claude-code", userQuestions: true },
			]),
		);
		expect(screen.queryByText("bash: NOT SANDBOXED (turned off)")).toBeNull();

		fireEvent.click(option);
		fireEvent.click(screen.getByRole("button", { name: "New session…" }));
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.start",
				cwd: "/work",
				model: "opus",
				backend: "claude-code",
				userQuestions: true,
				noSandbox: true,
			}),
		);
		const off = await screen.findByText("bash: NOT SANDBOXED (turned off)");
		expect(off.className).toContain("warning");
		expect(off.getAttribute("title")).toBe(
			"sandbox turned off for this session: every command asks for approval in normal mode, and goes to the classifier in auto mode",
		);
		fake.emit({ type: "sandbox_status", sandboxed: false, reason: "sandbox turned off for this session" });
		expect(screen.getAllByText(/^bash:/)).toHaveLength(1);
	});

	it("shows the sandbox warning in the turn and why a command was blocked in its tool row", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "sandbox_warning", reason: "sandbox turned off for this session" });
		expect(
			await screen.findByText(
				"bash runs without a sandbox (sandbox turned off for this session): every command asks for approval in normal mode, and goes to the classifier in auto mode",
			),
		).toBeTruthy();

		fake.emit({ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "touch /x" } });
		fake.emit({
			type: "tool_call_finished",
			callId: "c1",
			ok: false,
			summary: "touch /x (exit 1)",
			truncated: false,
			blocked: ["write to /x (not an allowed write path)", "and 2 more"],
		});
		const row = await screen.findByTestId("tool-row");
		expect(row.textContent).toContain("sandbox blocked: write to /x (not an allowed write path)");
		expect(row.textContent).toContain("sandbox blocked: and 2 more");
	});

	it("names the guard rule on the approval card of a command the sandbox contains", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "rm -r build" } });
		fake.emit({ type: "approval_requested", callId: "c1", command: "rm -r build", confirm: "recursive removal" });
		expect(await screen.findByText("Run this command? (guard: recursive removal)")).toBeTruthy();
		expect(screen.getByText("rm -r build")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() => expect(fake.commands.at(-1)).toMatchObject({ command: "session.approve", approved: true }));
	});

	it("names the guard rule and the reason when the command also leaves the sandbox", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "npm publish" } });
		fake.emit({
			type: "approval_requested",
			callId: "c1",
			command: "npm publish",
			reason: "needs the registry",
			confirm: "npm publish",
		});
		expect(await screen.findByText("Run this command outside the sandbox? (guard: npm publish)")).toBeTruthy();
		expect(screen.getByText("needs the registry")).toBeTruthy();
	});

	it("keeps the plain approval card when there is no reason", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "ls" } });
		fake.emit({ type: "approval_requested", callId: "c1", command: "ls" });
		expect(await screen.findByText("Run this command?")).toBeTruthy();
		expect(screen.queryByText(/outside the sandbox/)).toBeNull();
	});

	it("shows an edit approval in the same card, with the path, and answers it", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "edit", input: { path: "/tmp/other/a.txt" } });
		fake.emit({
			type: "approval_requested",
			callId: "c1",
			command: "edit /tmp/other/a.txt",
			reason: "outside the working directory",
			tool: "edit",
		});
		expect(await screen.findByText("Edit a file outside the working directory?")).toBeTruthy();
		expect(screen.getByText("edit /tmp/other/a.txt")).toBeTruthy();
		expect(screen.queryByText(/outside the sandbox/)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.approve",
				sessionId: "s1",
				callId: "c1",
				approved: true,
			}),
		);
		expect(await screen.findByText("Allowed")).toBeTruthy();
	});

	it("shows the MCP servers in the status bar and opens their details, asking the core for them", async () => {
		const fake = fakeBridge();
		fake.answers["session.mcp"] = {
			ok: true,
			result: {
				servers: [
					{ name: "docs", transport: "http", state: "connected", tools: ["search", "read"] },
					{
						name: "ctx",
						transport: "stdio",
						state: "failed",
						tools: [],
						error: "spawn npx ENOENT",
						stderr: "npm ERR! ***",
					},
				],
				problems: [],
			},
		};
		await openFolderAndSend(fake, "x");
		fake.emit({
			type: "mcp_status",
			servers: [
				{ name: "docs", transport: "http", state: "connecting", tools: [] },
				{ name: "ctx", transport: "stdio", state: "failed", tools: [], error: "spawn npx ENOENT" },
				{ name: "off", transport: "stdio", state: "disabled", tools: [] },
			],
			problems: [],
		});
		const chip = await screen.findByRole("button", { name: "MCP 0/2" });
		expect(chip.className).toContain("warning");
		fireEvent.click(chip);
		await waitFor(() => expect(fake.commands.at(-1)).toEqual({ command: "session.mcp", sessionId: "s1" }));
		const panel = await screen.findByRole("complementary", { name: "MCP servers" });
		await within(panel).findByText("docs (http): connected, 2 tools");
		expect(within(panel).getByText("search, read")).toBeTruthy();
		expect(within(panel).getByText("ctx (stdio): failed")).toBeTruthy();
		expect(within(panel).getByText("spawn npx ENOENT")).toBeTruthy();
		expect(within(panel).getByText("npm ERR! ***")).toBeTruthy();
		expect(screen.getByRole("button", { name: "MCP 1/2" })).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "MCP 1/2" }));
		expect(screen.queryByRole("complementary", { name: "MCP servers" })).toBeNull();
	});

	it("signs a server that needs it in from the MCP panel", async () => {
		const fake = fakeBridge();
		const needsAuth = {
			name: "jira",
			transport: "http" as const,
			state: "needs_auth" as const,
			tools: [],
			error: "sign-in required",
		};
		fake.answers["session.mcp"] = { ok: true, result: { servers: [needsAuth], problems: [] } };
		fake.answers["session.mcp_login"] = {
			ok: true,
			result: { servers: [{ name: "jira", transport: "http", state: "connected", tools: ["search"] }], problems: [] },
		};
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "mcp_status", servers: [needsAuth], problems: [] });
		fireEvent.click(await screen.findByRole("button", { name: "MCP 0/1" }));
		const panel = await screen.findByRole("complementary", { name: "MCP servers" });
		fireEvent.click(await within(panel).findByRole("button", { name: "Sign in to jira" }));
		await waitFor(() =>
			expect(fake.commands).toContainEqual({ command: "session.mcp_login", sessionId: "s1", server: "jira" }),
		);
		await within(panel).findByText("jira (http): connected, 1 tool");
	});

	it("asks to call an MCP tool the classifier left to the user", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "mcp_call", input: { server: "docs", tool: "search" } });
		fake.emit({ type: "approval_requested", callId: "c1", command: 'docs › search {"q":"x"}', tool: "mcp_call" });
		expect(await screen.findByText("Call this MCP tool?")).toBeTruthy();
		expect(screen.getByText('docs › search {"q":"x"}')).toBeTruthy();
		expect(screen.queryByText(/Run this command/)).toBeNull();
	});

	it("shows a write approval in the same card, with the path, and answers it", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({
			type: "tool_call_started",
			callId: "c1",
			tool: "write",
			input: { path: "/tmp/other/a.txt", content: "x" },
		});
		fake.emit({
			type: "approval_requested",
			callId: "c1",
			command: "write /tmp/other/a.txt",
			reason: "outside the working directory",
			tool: "write",
		});
		expect(await screen.findByText("Write a file outside the working directory?")).toBeTruthy();
		expect(screen.getByText("write /tmp/other/a.txt")).toBeTruthy();
		expect(screen.queryByText(/outside the sandbox/)).toBeNull();
		expect(screen.queryByText("outside the working directory")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Allow" }));
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.approve",
				sessionId: "s1",
				callId: "c1",
				approved: true,
			}),
		);
		expect(await screen.findByText("Allowed")).toBeTruthy();
	});

	it("denies an edit approval", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "tool_call_started", callId: "c1", tool: "edit", input: { path: "/tmp/other/a.txt" } });
		fake.emit({ type: "approval_requested", callId: "c1", command: "edit /tmp/other/a.txt", tool: "edit" });
		fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
		await waitFor(() => expect(fake.commands.at(-1)).toMatchObject({ command: "session.approve", approved: false }));
		expect(await screen.findByText("Denied")).toBeTruthy();
	});

	it("shows a failed command and lets the user try again", async () => {
		const fake = fakeBridge();
		fake.answers["session.send"] = { ok: false, error: { code: "busy", message: "A turn is already running." } };
		await openFolderAndSend(fake, "x");
		expect(await screen.findByText("busy: A turn is already running.")).toBeTruthy();
		expect(screen.getByRole("alert").textContent).toBe("A turn is already running.");
		expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).disabled).toBe(false);
	});

	it("tells the user when the core dies and offers a restart", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.push({ type: "core_exited", message: "The core stopped (exit code 1)." });
		expect(await screen.findByText("core_exited: The core stopped (exit code 1).")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Restart core" }));
		await waitFor(() => expect(fake.commands.at(-1)).toEqual({ command: "shutdown" }));
	});

	it("warns when the session is not using a subscription", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fake.emit({ type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "api_key" });
		expect(await screen.findByText("not using a Claude subscription (api_key)")).toBeTruthy();
	});

	it("interrupts the running turn", async () => {
		const fake = fakeBridge();
		await openFolderAndSend(fake, "x");
		fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
		await waitFor(() => expect(fake.commands.at(-1)).toEqual({ command: "session.interrupt", sessionId: "s1" }));
	});

	describe("verification", () => {
		const defect = {
			id: "D1",
			severity: "blocker" as const,
			summary: "A pasted y approves the command",
			reproduction: "printf 'ls\\ny' | node cli.ts",
			candidate: "ran ls",
			base: "asked again",
			onBase: false,
		};
		const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
		const started: AtelierEventBody = {
			type: "verification_started",
			verifyId: "v1",
			items: [2],
			declaration: [{ items: [2], reason: "guards approvals" }],
		};
		const round = (over: Record<string, unknown> = {}) =>
			({
				type: "verification_round",
				verifyId: "v1",
				round: 1,
				ok: true,
				requirements: [
					{ id: "R1", requirement: "approval needs a keypress", verdict: "unmet", evidence: "a pasted y approved it" },
					{ id: "R2", requirement: "Ctrl+C cancels", verdict: "met", evidence: "ran it" },
				],
				defects: [defect, { ...defect, id: "D2", severity: "minor", onBase: true }],
				blocking: ["D1"],
				correcting: true,
				usage,
				...over,
			}) as AtelierEventBody;
		const finished = (over: Record<string, unknown> = {}) =>
			({
				type: "verification_finished",
				verifyId: "v1",
				outcome: "needs_decision",
				rounds: 2,
				openDefects: [defect],
				usage,
				...over,
			}) as AtelierEventBody;

		it("shows the declared item, each round's verdicts and defects, and that the user must decide", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(started);
			fake.emit(round());
			fake.emit({
				type: "text_delta",
				text: "probing",
				parentCallId: "v1",
				agent: "verify:verifier",
			} as unknown as AtelierEventBody);
			fake.emit(round({ round: 2, correcting: false }));
			fake.emit(finished());
			const block = await screen.findByTestId("verification");
			expect(block.textContent).toContain("Verification · item 2");
			expect(block.textContent).toContain("guards approvals");
			expect(block.textContent).toContain("Round 1");
			expect(block.textContent).toContain("unmet");
			expect(block.textContent).toContain("approval needs a keypress");
			expect(block.textContent).toContain("a pasted y approved it");
			expect(block.textContent).toContain("D1 blocker A pasted y approves the command");
			expect(block.textContent).toContain("printf 'ls\\ny' | node cli.ts");
			expect(block.textContent).toContain("D2 minor");
			expect(block.textContent).toContain("also on the base");
			expect(within(block).getAllByTestId("subagent")[0]?.textContent).toContain("verify:verifier");
			expect(within(block).getByRole("alert").textContent).toContain("Needs your decision: 1 open defect");
		});

		it.each([
			["passed", {}, "Verification passed"],
			["corrected", { openDefects: [] }, "Verification passed after a correction"],
			["failed", { reason: "model down", openDefects: [] }, "Verification failed: model down. Needs your decision."],
		])("says %s", async (outcome, over, text) => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(started);
			fake.emit(finished({ outcome, ...over }));
			expect((await screen.findByTestId("verification")).textContent).toContain(text);
		});

		it("shows the cause and the value observed of a failed round and of the outcome", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(started);
			fake.emit(
				round({
					ok: false,
					error: "The verifier returned an invalid report: no JSON",
					cause: "invalid_report",
					observed: "looks fine to me",
					requirements: [],
					defects: [],
					blocking: [],
					correcting: false,
				}),
			);
			fake.emit(
				finished({
					outcome: "failed",
					reason: "The verifier returned an invalid report: no JSON",
					cause: "invalid_report",
					observed: "looks fine to me",
					openDefects: [],
				}),
			);
			const block = await screen.findByTestId("verification");
			expect(block.textContent).toContain("Round 1 · failed");
			expect(within(block).getAllByText("invalid_report (looks fine to me)").length).toBeGreaterThan(0);
			expect(within(block).getByRole("alert").textContent).toBe(
				"Verification failed: invalid_report (looks fine to me). Needs your decision.",
			);
		});

		it("puts the cause before what is left to decide", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(started);
			fake.emit(finished({ cause: "open_defects", observed: "D1" }));
			expect((await screen.findByRole("alert")).textContent).toBe("Needs your decision: open_defects (D1)");
		});

		it("says what could not be verified when no defect is open", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(started);
			fake.emit(
				finished({ reason: "1 unverified requirement: R1 the approval needs a keypress (no tests)", openDefects: [] }),
			);
			expect((await screen.findByRole("alert")).textContent).toBe(
				"Needs your decision: 1 unverified requirement: R1 the approval needs a keypress (no tests)",
			);
		});

		it("says it is verifying until the outcome arrives, and that it stopped when the turn ends first", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(started);
			expect((await screen.findByTestId("verification")).textContent).toContain("Verifying…");
			fake.emit({ type: "turn_finished", stopReason: "interrupted", usage });
			await waitFor(() =>
				expect(screen.getByTestId("verification").textContent).toContain("The verification stopped without a result."),
			);
		});
	});

	describe("review", () => {
		const consent: AtelierEventBody = {
			type: "review_consent_requested",
			reviewId: "r1",
			level: "high",
			reasons: ["path: src/auth.ts (auth)"],
			lenses: ["risk", "resilience", "readability", "reliability"],
		};
		const finishedReview: AtelierEventBody = {
			type: "review_finished",
			reviewId: "r1",
			verdict: "approved",
			findings: [],
			refuted: [],
			followUps: [],
			correction: null,
			receiptPath: "/repo/.git/atelier/reviews/abc.json",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
		};

		it("asks for consent with the question and three buttons only, and sends the answer", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(consent);
			const card = await screen.findByRole("group", { name: "Review this high-risk change?" });
			expect(card.textContent).not.toContain("path: src/auth.ts (auth)");
			expect(card.textContent).not.toContain("resilience");
			expect(
				within(card)
					.getAllByRole("button")
					.map((button) => button.textContent),
			).toEqual(["Review this change", "Skip this time", "Review all this session"]);
			fireEvent.click(within(card).getByRole("button", { name: "Review this change" }));
			await waitFor(() =>
				expect(fake.commands.at(-1)).toEqual({
					command: "session.review_consent",
					sessionId: "s1",
					reviewId: "r1",
					answer: "granted",
				}),
			);
			expect(within(card).queryAllByRole("button")).toEqual([]);
		});

		it.each([
			["Skip this time", "declined"],
			["Review all this session", "granted_for_session"],
		])("sends the answer of %s", async (name, answer) => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(consent);
			fireEvent.click(await screen.findByRole("button", { name }));
			await waitFor(() =>
				expect(fake.commands.at(-1)).toEqual({
					command: "session.review_consent",
					sessionId: "s1",
					reviewId: "r1",
					answer,
				}),
			);
		});

		it("says on the review block that the session's reviews were allowed", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({
				type: "review_assessed",
				tree: "t",
				level: "high",
				reasons: ["path: src/auth.ts (auth)"],
				files: ["src/auth.ts"],
				changedLines: 1,
				lenses: ["risk"],
				reviewDue: true,
				consent: "session",
			});
			await waitFor(() => expect(screen.getByTestId("review").textContent).toContain("Allowed for this session"));
		});

		it("closes the card when the review finishes", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(consent);
			await screen.findByRole("button", { name: "Skip this time" });
			fake.emit(finishedReview);
			await waitFor(() => expect(screen.queryByRole("button", { name: "Skip this time" })).toBeNull());
			expect(screen.queryByRole("button", { name: "Review this change" })).toBeNull();
		});

		it("shows the review: risk, lenses as folded blocks, verdict and receipt", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({
				type: "review_assessed",
				tree: "t",
				level: "high",
				reasons: ["path: src/auth.ts (auth)"],
				files: ["src/auth.ts"],
				changedLines: 9,
				lenses: ["risk", "resilience"],
				reviewDue: true,
			});
			fake.emit({ ...consent, lenses: ["risk", "resilience"] });
			const role = (body: Record<string, unknown>, agent: string) =>
				fake.emit({ ...body, parentCallId: "r1", agent } as unknown as AtelierEventBody);
			role({ type: "session_started", backend: "fake", model: "opus", authSource: "subscription" }, "review:risk");
			role({ type: "text_delta", text: "no findings" }, "review:risk");
			role({ type: "text_delta", text: "fine" }, "review:resilience");
			fake.emit(finishedReview);
			const block = await screen.findByTestId("review");
			expect(block.textContent).toContain("high risk");
			expect(block.textContent).toContain("path: src/auth.ts (auth)");
			const lenses = within(block).getAllByTestId("subagent");
			expect(lenses.map((lens) => lens.textContent)).toEqual([
				expect.stringContaining("review:risk · opus"),
				expect.stringContaining("review:resilience"),
			]);
			expect(lenses[0]?.textContent).toContain("no findings");
			expect(lenses.every((lens) => !(lens as HTMLDetailsElement).open)).toBe(true);
			expect(block.textContent).toContain("Approved");
			expect(block.textContent).toContain("/repo/.git/atelier/reviews/abc.json");
			expect(block.textContent).not.toContain("left in your worktree");
		});

		it("shows the lenses the agent chose and why, in the review block and the consent card", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			const chosen = { lenses: ["risk", "readability"], lensesReason: "renames the output" };
			fake.emit({
				type: "review_assessed",
				tree: "t",
				level: "high",
				reasons: ["path: src/auth.ts (auth)"],
				files: ["src/auth.ts"],
				changedLines: 9,
				reviewDue: true,
				...chosen,
			});
			fake.emit({ ...consent, ...chosen });
			const block = await screen.findByTestId("review");
			expect(block.textContent).toContain("2 lenses: risk, readability");
			expect(block.textContent).toContain("Lenses chosen: renames the output");
			// The card asks only the question: the lenses and why are in the review block.
			const card = await screen.findByRole("group", { name: "Review this high-risk change?" });
			expect(card.textContent).not.toContain("renames the output");
		});

		it("shows the agent's risk declaration in the review block", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({
				type: "review_assessed",
				tree: "t",
				level: "medium",
				reasons: ["code change without a high-risk signal"],
				files: ["a.ts"],
				changedLines: 1,
				lenses: ["reliability"],
				reviewDue: false,
				declaration: { kind: "none", reason: "no shared code" },
			});
			const block = await screen.findByTestId("review");
			expect(block.textContent).toContain("Declared none: no shared code");
		});

		it("shows the base of the candidate when the turn's commits are included or the base fell back to HEAD", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({
				type: "review_assessed",
				tree: "t",
				level: "medium",
				reasons: [],
				files: ["a.ts"],
				changedLines: 1,
				lenses: ["reliability"],
				reviewDue: false,
				since: "1a2b3c4",
				baseNote: "HEAD no longer descends from 9f8e7d6, where the turn started: the base is the current HEAD",
			});
			const block = await screen.findByTestId("review");
			expect(block.textContent).toContain("since 1a2b3c4");
			expect(block.textContent).toContain("HEAD no longer descends from 9f8e7d6");
		});

		it("stops showing Reviewing… when the turn ends without a result", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "/review");
			fake.emit({ type: "review_progress", reviewId: "r1", step: { type: "lens_started", lens: "risk" } });
			const block = await screen.findByTestId("review");
			expect(block.textContent).toContain("Reviewing…");
			fake.emit({ type: "error", code: "review_failed", message: "git failed", recoverable: true });
			fake.emit({
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
			// A finished turn is rendered anew, so the block is looked up again.
			await waitFor(() => expect(screen.getByTestId("review").textContent).not.toContain("Reviewing…"));
			expect(screen.getByTestId("review").textContent).toContain("The review stopped without a result.");
		});

		it("warns plainly that an escalated review left its correction in the worktree", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({
				...finishedReview,
				verdict: "escalated",
				reason: "The correction changed 30 lines, over the budget of 12.",
				correction: { budget: 12, used: 30 },
			} as AtelierEventBody);
			const warning = await screen.findByRole("alert");
			expect(warning.textContent).toContain("Escalated: The correction changed 30 lines, over the budget of 12.");
			expect(warning.textContent).toContain("The correction is left in your worktree. Review it before committing.");
		});

		it("undoes an escalated correction from the review block and says what came back", async () => {
			const fake = fakeBridge();
			fake.answers["session.undo_correction"] = { ok: true, result: { turnId: "t2" } };
			await openFolderAndSend(fake, "x");
			fake.emit({
				...finishedReview,
				verdict: "escalated",
				reason: "The correction changed 30 lines, over the budget of 12.",
				correction: { budget: 12, used: 30 },
			} as AtelierEventBody);
			fake.emit({ type: "turn_finished", stopReason: "end_turn", usage: finishedReview.usage } as AtelierEventBody);
			const review = await screen.findByTestId("review");
			fireEvent.click(within(review).getByRole("button", { name: "Undo correction" }));
			await waitFor(() =>
				expect(fake.commands.at(-1)).toEqual({ command: "session.undo_correction", sessionId: "s1", reviewId: "r1" }),
			);
			fake.push({
				type: "event",
				sessionId: "s1",
				event: {
					type: "correction_undone",
					reviewId: "r1",
					restored: ["a.ts"],
					removed: ["b.ts"],
					seq: 1,
					turnId: "t2",
				},
			});
			await waitFor(() =>
				expect(screen.getByTestId("review").textContent).toContain("Correction undone · restored a.ts · removed b.ts"),
			);
			expect(within(screen.getByTestId("review")).queryByRole("button", { name: "Undo correction" })).toBeNull();
		});

		it("offers no undo for a review that did not leave a correction", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({ ...finishedReview, correction: { budget: 2, used: 2 } } as AtelierEventBody);
			fake.emit({
				...finishedReview,
				reviewId: "r2",
				verdict: "escalated",
				reason: "The correction failed.",
			} as AtelierEventBody);
			await screen.findByRole("alert");
			expect(screen.queryByRole("button", { name: "Undo correction" })).toBeNull();
		});

		it("does not claim a correction when none was applied, and says declined or unavailable", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({ ...finishedReview, verdict: "escalated", reason: "The correction failed." } as AtelierEventBody);
			expect((await screen.findByRole("alert")).textContent).not.toContain("left in your worktree");
			fake.emit({ ...finishedReview, reviewId: "r2", verdict: "declined" } as AtelierEventBody);
			fake.emit({ ...finishedReview, reviewId: "r3", verdict: "unavailable", reason: "no HEAD" } as AtelierEventBody);
			expect(await screen.findByText("Review declined")).toBeTruthy();
			expect(await screen.findByText("Review unavailable: no HEAD")).toBeTruthy();
		});

		it("shows the cause and the value observed instead of the reason", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({
				...finishedReview,
				verdict: "escalated",
				reason: "The correction changed 30 lines, over the budget of 12.",
				cause: "over_budget",
				observed: "30 lines, budget 12",
			} as AtelierEventBody);
			expect((await screen.findByRole("alert")).textContent).toContain("Escalated: over_budget (30 lines, budget 12)");
			fake.emit({
				...finishedReview,
				reviewId: "r2",
				verdict: "unavailable",
				reason: "Lens reliability returned an invalid reply twice: ...",
				cause: "invalid_reply",
				observed: "looks fine to me",
			} as AtelierEventBody);
			expect(await screen.findByText("Review unavailable: invalid_reply (looks fine to me)")).toBeTruthy();
		});

		it("has a Review button that sends session.review, disabled without a session and while a turn runs", async () => {
			const fake = fakeBridge();
			render(<App bridge={fake.bridge} />);
			await screen.findByText("core 0.0.0");
			expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(true);
			fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
			await screen.findByText("/work");
			const button = screen.getByRole("button", { name: "Review" }) as HTMLButtonElement;
			expect(button.disabled).toBe(false);
			fake.answers["session.review"] = { ok: true, result: { turnId: "t1" } };
			fireEvent.click(button);
			await waitFor(() => expect(fake.commands.at(-1)).toEqual({ command: "session.review", sessionId: "s1" }));
			await waitFor(() => expect(button.disabled).toBe(true));
			fake.emit({
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
			await waitFor(() => expect(button.disabled).toBe(false));
		});

		it("says in the status bar why there is no review", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({ type: "review_status", available: false, reason: "not a git repository" });
			await waitFor(() => expect(screen.getByRole("status").textContent).toContain("no review: not a git repository"));
		});

		it("keeps the review on by default when opening a session", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			expect(fake.commands[0]).not.toHaveProperty("review");
		});
	});

	describe("compaction", () => {
		it("sends /compact with its instructions as a compaction, not as a prompt", async () => {
			const fake = fakeBridge();
			fake.answers["session.compact"] = { ok: true, result: { turnId: "t2" } };
			await openFolderAndSend(fake, "first");
			fake.emit({
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			});
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Interrupt" }).hasAttribute("disabled")).toBe(true),
			);
			const box = screen.getByLabelText("Prompt");
			fireEvent.change(box, { target: { value: "/compact keep the API decisions" } });
			fireEvent.keyDown(box, { key: "Enter" });
			await waitFor(() =>
				expect(fake.commands.at(-1)).toEqual({
					command: "session.compact",
					sessionId: "s1",
					instructions: "keep the API decisions",
				}),
			);
			fake.emit({
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			});
			await waitFor(() =>
				expect(screen.getByRole("button", { name: "Interrupt" }).hasAttribute("disabled")).toBe(true),
			);
			fireEvent.change(box, { target: { value: "/compact" } });
			fireEvent.keyDown(box, { key: "Enter" });
			await waitFor(() => expect(fake.commands.at(-1)).toEqual({ command: "session.compact", sessionId: "s1" }));
		});

		it("shows a separator for the compaction and how full the context is in the status bar", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({ type: "compaction_started", reason: "threshold", tokens: 180_000 });
			expect(await screen.findByText("Compacting context… (threshold, 180,000 tokens)")).toBeTruthy();
			fake.emit({
				type: "compaction_finished",
				ok: true,
				reason: "threshold",
				tokensBefore: 180_000,
				tokensAfter: 30_000,
				kept: 3,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				costUsd: 0.012,
			});
			fake.emit({ type: "cache_miss", reason: "messages_changed", missedTokens: 500 });
			fake.emit({
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				context: { tokens: 45_000, window: 200_000, compactAt: 167_616 },
			});
			expect(
				await screen.findByText("Context compacted · 180,000 → 30,000 tokens · 3 messages kept · $0.0120"),
			).toBeTruthy();
			expect(screen.getByText("cache miss after compaction: messages_changed (expected)")).toBeTruthy();
			const label = within(screen.getByRole("status")).getByText("ctx ▰▰▱▱▱▱▱▱ 23% · 200k");
			expect(label.getAttribute("title")).toBe("45,000 of 200,000 tokens · compacts at 167,616 tokens");
		});

		it("colors the context by how close compaction is, and warns once near it", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
			fake.emit({
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				context: { tokens: 150_000, window: 1_000_000, compactAt: 200_000 },
			});
			const status = within(screen.getByRole("status"));
			expect((await status.findByText("ctx ▰▱▱▱▱▱▱▱ 15% · 1M")).className).toBe("warning");
			fake.emit({ type: "context_warning", tokens: 190_000, window: 1_000_000, compactAt: 200_000 });
			fake.emit({
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				context: { tokens: 190_000, window: 1_000_000, compactAt: 200_000 },
			});
			expect((await status.findByText("ctx ▰▰▱▱▱▱▱▱ 19% · 1M")).className).toBe("error");
			expect(
				screen.getByText("⚠ context at 19% of the 1M window (190,000 tokens), near where it compacts (200,000)"),
			).toBeTruthy();
		});

		it("says the size is unknown as soon as the main agent compacts, and hides it when the model changes", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
			fake.emit({ type: "session_started", backend: "anthropic-api", model: "claude-opus-5-5", authSource: "api_key" });
			fake.emit({
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				context: { tokens: 400_000, window: 1_000_000, compactAt: 983_616 },
			});
			const status = within(screen.getByRole("status"));
			expect(await status.findByText("ctx ▰▰▰▱▱▱▱▱ 40% · 1M")).toBeTruthy();
			fake.emit({ type: "compaction_finished", ok: true, reason: "manual", tokensBefore: 400_000, kept: 1, usage });
			expect(await status.findByText("ctx ▱▱▱▱▱▱▱▱ ? · 1M")).toBeTruthy();
			fake.emit({
				type: "session_started",
				backend: "anthropic-api",
				model: "claude-haiku-5-5",
				authSource: "api_key",
			});
			await waitFor(() => expect(status.queryByText(/^ctx /)).toBeNull());
		});

		it("hides the context when the model changes during a turn, until the new model measures it", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
			fake.emit({ type: "session_started", backend: "anthropic-api", model: "first", authSource: "api_key" });
			fake.emit({
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				context: { tokens: 182_000, window: 1_000_000, compactAt: 200_000 },
			});
			const status = within(screen.getByRole("status"));
			expect(await status.findByText("ctx ▰▱▱▱▱▱▱▱ 18% · 1M")).toBeTruthy();
			fake.emit({ type: "session_configured", backend: "anthropic-api", model: "other", permissionMode: "normal" });
			fake.emit({ type: "turn_finished", stopReason: "end_turn", usage });
			await waitFor(() => expect(screen.queryByText(/^ctx /)).toBeNull());
		});

		it("keeps the model that answered a turn when a change of model lands as the turn ends", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
			const send = (turnId: string, seq: number, body: AtelierEventBody) =>
				fake.push({ type: "event", sessionId: "s1", event: { ...body, seq, turnId } as never });
			send("t1", 1, { type: "session_started", backend: "anthropic-api", model: "first", authSource: "api_key" });
			send("t1", 2, {
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				context: { tokens: 182_000, window: 1_000_000, compactAt: 200_000 },
			});
			const status = within(screen.getByRole("status"));
			expect(await status.findByText("ctx ▰▱▱▱▱▱▱▱ 18% · 1M")).toBeTruthy();
			send("t2", 1, { type: "text_delta", text: "answered by first" });
			// The change asked during the turn lands as it ends, before its turn_finished.
			send("t2", 2, { type: "session_configured", backend: "anthropic-api", model: "other", permissionMode: "normal" });
			send("t2", 3, { type: "turn_finished", stopReason: "end_turn", usage });
			const summaries = () =>
				screen.getAllByTestId("usage").map((usage) => usage.querySelector("summary")?.textContent);
			await waitFor(() => expect(summaries()).toHaveLength(2));
			expect(summaries()[1]).toMatch(/^first · /);
			expect(status.getByText("other")).toBeTruthy();
			expect(status.queryByText(/^ctx /)).toBeNull();
		});

		it("drops the model of the backend left when the configuration moves to another backend without one", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({ type: "session_started", backend: "anthropic-api", model: "first", authSource: "api_key" });
			const status = within(screen.getByRole("status"));
			expect(await status.findByText("first")).toBeTruthy();
			fake.emit({ type: "session_configured", backend: "openai-codex", permissionMode: "normal" });
			await waitFor(() => expect(status.queryByText("first")).toBeNull());
		});

		it("says the context size is unknown right after a compaction", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({
				type: "turn_finished",
				stopReason: "end_turn",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
				context: { tokens: 3000, window: 1_000_000, compactAt: 967_000, unknown: true },
			});
			const label = await within(screen.getByRole("status")).findByText("ctx ▱▱▱▱▱▱▱▱ ? · 1M");
			expect(label.getAttribute("title")).toBe("compacts at 967,000 tokens");
		});

		it("says why a compaction failed", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit({
				type: "compaction_finished",
				ok: false,
				reason: "manual",
				tokensBefore: 900,
				kept: 0,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				error: "There is not enough history to compact.",
			});
			expect(await screen.findByText("Compaction failed: There is not enough history to compact.")).toBeTruthy();
		});
	});
});
