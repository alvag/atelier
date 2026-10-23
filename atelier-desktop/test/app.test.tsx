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
	const listeners = new Set<(message: HostMessage) => void>();
	let seq = 0;
	const answers: Partial<Record<ClientCommand["command"], CommandResult>> = {
		"session.start": { ok: true, result: { sessionId: "s1" } },
		"session.send": { ok: true, result: { turnId: "t1" } },
	};
	const bridge: AtelierBridge = {
		request: async (command) => {
			commands.push(command);
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
	return { bridge, commands, answers, push, emit };
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
			{ command: "session.start", cwd: "/work", model: "opus", backend: "claude-code" },
			{ command: "session.send", sessionId: "s1", prompt: "add validation" },
		]);
		expect(screen.getByText("add validation")).toBeTruthy();
		expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("");
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
				{ command: "session.start", cwd: "/work", model: "claude-sonnet-5-5", backend: "anthropic-api" },
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
		// The parent's composer stays busy until the parent's own turn ends.
		expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
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

		it("asks for consent with exactly two buttons and sends the answer", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(consent);
			const card = await screen.findByRole("group", { name: "Review this change?" });
			expect(card.textContent).toContain("high");
			expect(card.textContent).toContain("path: src/auth.ts (auth)");
			expect(card.textContent).toContain("risk, resilience, readability, reliability");
			expect(
				within(card)
					.getAllByRole("button")
					.map((button) => button.textContent),
			).toEqual(["Review this change", "Not now"]);
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

		it("sends declined for Not now", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(consent);
			fireEvent.click(await screen.findByRole("button", { name: "Not now" }));
			await waitFor(() =>
				expect(fake.commands.at(-1)).toEqual({
					command: "session.review_consent",
					sessionId: "s1",
					reviewId: "r1",
					answer: "declined",
				}),
			);
		});

		it("closes the card when the review finishes", async () => {
			const fake = fakeBridge();
			await openFolderAndSend(fake, "x");
			fake.emit(consent);
			await screen.findByRole("button", { name: "Not now" });
			fake.emit(finishedReview);
			await waitFor(() => expect(screen.queryByRole("button", { name: "Not now" })).toBeNull());
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
			expect(within(screen.getByRole("status")).getByText("context 45,000 / 200,000 (23%)")).toBeTruthy();
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
