// @vitest-environment happy-dom
import type { AtelierEventBody, ClientCommand, UserQuestion } from "@atelier/core/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../src/renderer/src/App.tsx";
import { initialChatState, reduceChat } from "../src/renderer/src/chat/reducer.ts";
import type { AtelierBridge, CommandResult, HostMessage } from "../src/shared/bridge.ts";

afterEach(cleanup);

const questions: UserQuestion[] = [
	{
		id: "q1",
		question: "Which database?",
		options: [
			{ id: "a", label: "SQLite" },
			{ id: "b", label: "Postgres", description: "Needs a server", recommended: true },
		],
	},
	{
		id: "q2",
		question: "Which license?",
		options: [
			{ id: "m", label: "MIT", recommended: true },
			{ id: "g", label: "GPL" },
		],
	},
];

function setup() {
	const commands: ClientCommand[] = [];
	const listeners = new Set<(message: HostMessage) => void>();
	const answers: Partial<Record<ClientCommand["command"], CommandResult>> = {
		"session.start": { ok: true, result: { sessionId: "s1" } },
		"session.send": { ok: true, result: { turnId: "t1" } },
	};
	let hold: Promise<void> | undefined;
	const bridge: AtelierBridge = {
		request: async (command) => {
			if (command.command !== "profiles.list") commands.push(command);
			if (command.command === "session.answer_user") await hold;
			return answers[command.command] ?? { ok: true, result: {} };
		},
		onMessage: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		restartCore: async () => {},
		getStatus: async () => ({ type: "core_ready", version: "0.0.0" }),
		pickFolder: async () => "/work",
	};
	let seq = 0;
	const push = (message: HostMessage) =>
		act(() => {
			for (const listener of listeners) listener(message);
		});
	const emit = (body: AtelierEventBody) =>
		push({ type: "event", sessionId: "s1", event: { ...body, seq: ++seq, turnId: "t1" } as never });
	return {
		bridge,
		commands,
		answers,
		emit,
		push,
		holdAnswers: () => {
			let release = () => {};
			hold = new Promise<void>((resolve) => {
				release = resolve;
			});
			return release;
		},
	};
}

async function open(fake: ReturnType<typeof setup>, asked: UserQuestion[] = questions) {
	render(<App bridge={fake.bridge} />);
	await screen.findByText("core 0.0.0");
	fireEvent.click(screen.getByRole("button", { name: "Open folder…" }));
	await screen.findByText("/work");
	const box = screen.getByLabelText("Prompt");
	fireEvent.change(box, { target: { value: "x" } });
	fireEvent.keyDown(box, { key: "Enter" });
	await waitFor(() => expect(fake.commands.at(-1)?.command).toBe("session.send"));
	fake.emit({ type: "user_question_requested", callId: "u1", questions: asked });
	await screen.findByText(asked[0]?.question as string);
}

const send = () => screen.getByRole("button", { name: "Send answers" }) as HTMLButtonElement;

describe("ask_user card", () => {
	it("opts in on session.start", async () => {
		const fake = setup();
		await open(fake);
		expect(fake.commands[0]).toMatchObject({ command: "session.start", userQuestions: true });
	});

	it("shows every question, the recommended option first, nothing preselected, Other always offered", async () => {
		const fake = setup();
		await open(fake);
		expect(screen.getByText("Which license?")).toBeTruthy();
		const radios = screen.getAllByRole("radio") as HTMLInputElement[];
		expect(radios.some((radio) => radio.checked)).toBe(false);
		const first = screen.getByRole("group", { name: "Which database?" });
		const labels = Array.from(first.querySelectorAll("label")).map((label) => label.textContent);
		expect(labels).toEqual(["Postgres (Recommended)Needs a server", "SQLite", "Other…"]);
		expect(send().disabled).toBe(true);
	});

	it("sends one answer per question, preserving Other whitespace, once", async () => {
		const fake = setup();
		await open(fake);
		const release = fake.holdAnswers();
		fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
		const other = screen.getAllByRole("radio", { name: "Other…" });
		fireEvent.click(other[1] as HTMLElement);
		expect(send().disabled).toBe(true);
		const text = "  line1\n\tline2  ";
		fireEvent.change(screen.getByLabelText("Your answer to: Which license?"), { target: { value: text } });
		expect(send().disabled).toBe(false);
		fireEvent.click(send());
		fireEvent.click(send());
		await waitFor(() => expect(fake.commands.filter((c) => c.command === "session.answer_user")).toHaveLength(1));
		expect(fake.commands.at(-1)).toEqual({
			command: "session.answer_user",
			sessionId: "s1",
			callId: "u1",
			answers: [
				{ questionId: "q1", optionId: "a" },
				{ questionId: "q2", other: text },
			],
		});
		release();
	});

	it("treats Object.prototype names as ordinary question ids", async () => {
		const fake = setup();
		const ids = ["__proto__", "constructor", "toString"];
		await open(
			fake,
			ids.map((id) => ({
				id,
				question: `Q ${id}?`,
				options: [
					{ id: "a", label: `A ${id}`, recommended: true },
					{ id: "b", label: `B ${id}` },
				],
			})),
		);
		expect((screen.getAllByRole("radio") as HTMLInputElement[]).some((radio) => radio.checked)).toBe(false);
		expect(send().disabled).toBe(true);
		fireEvent.click(screen.getByRole("radio", { name: /^A __proto__/ }));
		fireEvent.click(screen.getByRole("radio", { name: "B constructor" }));
		expect(send().disabled).toBe(true);
		fireEvent.click(screen.getAllByRole("radio", { name: "Other…" })[2] as HTMLElement);
		expect(send().disabled).toBe(true);
		fireEvent.change(screen.getByLabelText("Your answer to: Q toString?"), { target: { value: " verbatim " } });
		expect(send().disabled).toBe(false);
		fireEvent.click(send());
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.answer_user",
				sessionId: "s1",
				callId: "u1",
				answers: [
					{ questionId: "__proto__", optionId: "a" },
					{ questionId: "constructor", optionId: "b" },
					{ questionId: "toString", other: " verbatim " },
				],
			}),
		);
	});

	it("rejects blank or over-long Other text", async () => {
		const fake = setup();
		await open(fake);
		fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
		fireEvent.click(screen.getAllByRole("radio", { name: "Other…" })[1] as HTMLElement);
		const box = screen.getByLabelText("Your answer to: Which license?");
		fireEvent.change(box, { target: { value: " \n " } });
		expect(send().disabled).toBe(true);
		fireEvent.change(box, { target: { value: "x".repeat(2001) } });
		expect(send().disabled).toBe(true);
		fireEvent.change(box, { target: { value: "x".repeat(2000) } });
		expect(send().disabled).toBe(false);
	});

	it("cancels with answers: null and no partial answers", async () => {
		const fake = setup();
		await open(fake);
		fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(fake.commands.at(-1)).toEqual({
				command: "session.answer_user",
				sessionId: "s1",
				callId: "u1",
				answers: null,
			}),
		);
	});

	it("keeps the pending card, with its draft, when the command fails", async () => {
		const fake = setup();
		await open(fake);
		fake.answers["session.answer_user"] = { ok: false, error: { code: "invalid_answer", message: "bad" } };
		fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
		fireEvent.click(screen.getAllByRole("radio", { name: /MIT/ })[0] as HTMLElement);
		fireEvent.click(send());
		await waitFor(() => expect(screen.getByText(/invalid_answer/)).toBeTruthy());
		await waitFor(() => expect(send().disabled).toBe(false));
		expect((screen.getByRole("radio", { name: /SQLite/ }) as HTMLInputElement).checked).toBe(true);
	});

	it.each(["core_failed", "core_exited"] as const)("drops question inputs when %s loses the session", async (type) => {
		const fake = setup();
		await open(fake);
		fireEvent.click(screen.getAllByRole("radio", { name: "Other…" })[0] as HTMLElement);
		fireEvent.change(screen.getByLabelText("Your answer to: Which database?"), { target: { value: "unsent draft" } });
		fake.push({ type, message: "Core stopped" });
		await waitFor(() => expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull());
		expect(screen.queryAllByRole("radio")).toHaveLength(0);
		expect(screen.queryByDisplayValue("unsent draft")).toBeNull();
		expect(fake.commands.filter((command) => command.command === "session.answer_user")).toHaveLength(0);
	});

	it("is closed by the resolved event only, which also drops the drafts", async () => {
		const fake = setup();
		await open(fake);
		fireEvent.click(screen.getByRole("radio", { name: /SQLite/ }));
		fake.emit({ type: "user_question_resolved", callId: "u1", result: { status: "superseded" } });
		await waitFor(() => expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull());
		expect(screen.queryAllByRole("radio")).toHaveLength(0);
		expect(screen.getByText(/superseded/i)).toBeTruthy();
	});
});

describe("ask_user reducer", () => {
	it("records the request and its result", () => {
		const base = reduceChat(reduceChat(initialChatState, { type: "session_opened", sessionId: "s1", cwd: "/w" }), {
			type: "prompt_sent",
			text: "x",
		});
		const requested = reduceChat(base, {
			type: "event",
			sessionId: "s1",
			event: { type: "user_question_requested", callId: "u1", questions, seq: 1, turnId: "t1" } as never,
		});
		expect(requested.turns[0]?.items[0]).toMatchObject({ kind: "question", callId: "u1", state: "pending" });
		const done = reduceChat(requested, {
			type: "event",
			sessionId: "s1",
			event: {
				type: "user_question_resolved",
				callId: "u1",
				result: { status: "cancelled", reason: "user" },
				seq: 2,
				turnId: "t1",
			} as never,
		});
		expect(done.turns[0]?.items[0]).toMatchObject({ kind: "question", state: "resolved" });
	});
});
