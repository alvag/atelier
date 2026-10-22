// @vitest-environment happy-dom
import type { AtelierEventBody, ClientCommand } from "@atelier/core/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
			{ command: "session.start", cwd: "/work", model: "opus" },
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
			screen.getByText("tokens: input 1,200 · output 85 · cache read 9,000 · cache write 3,100 · $0.0421"),
		).toBeTruthy();
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
});
