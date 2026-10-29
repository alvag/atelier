// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuestionCard } from "../src/renderer/src/chat/QuestionCard.tsx";
import type { TurnItem } from "../src/renderer/src/chat/reducer.ts";

afterEach(cleanup);
const item: Extract<TurnItem, { kind: "question" }> = {
	kind: "question",
	callId: "u1",
	state: "pending",
	questions: [
		{
			id: "q1",
			question: "Which?",
			options: [
				{ id: "a", label: "First" },
				{ id: "b", label: "Second", description: "More detail", recommended: true },
			],
		},
	],
};
const send = () => screen.getByRole("button", { name: "Send answers" }) as HTMLButtonElement;

it("shows the recommended option first without choosing, and sends only an explicit selection", async () => {
	const answer = vi.fn().mockResolvedValue(true);
	render(<QuestionCard item={item} onAnswerUser={answer} />);
	expect(screen.getAllByRole("radio").map((radio) => radio.parentElement?.textContent)).toEqual([
		"Second (Recommended)More detail",
		"First",
		"Other…",
	]);
	expect((screen.getAllByRole("radio") as HTMLInputElement[]).some((radio) => radio.checked)).toBe(false);
	expect(send().disabled).toBe(true);
	fireEvent.click(screen.getByRole("radio", { name: "First" }));
	fireEvent.click(send());
	await waitFor(() => expect(answer).toHaveBeenCalledExactlyOnceWith("u1", [{ questionId: "q1", optionId: "a" }]));
	expect(send().disabled).toBe(true);
});

it("neutralizes Arabic Letter Mark in desktop questions, labels and descriptions", () => {
	const answer = vi.fn().mockResolvedValue(true);
	const { container } = render(
		<QuestionCard
			item={{
				...item,
				questions: [
					{
						id: "q1",
						question: "Q\u061C?",
						options: [
							{ id: "a", label: "L\u061C", description: "D\u061C", recommended: true },
							{ id: "b", label: "Second" },
						],
					},
				],
			}}
			onAnswerUser={answer}
		/>,
	);
	expect(container.textContent).not.toContain("\u061C");
	for (const text of ["Q⟨U+061C⟩?", "L⟨U+061C⟩", "D⟨U+061C⟩"]) expect(container.textContent).toContain(text);
	expect(answer).not.toHaveBeenCalled();
});

it("validates Other, keeps its text, and gives the draft back on a rejected send", async () => {
	const answer = vi.fn().mockResolvedValue(false);
	render(<QuestionCard item={item} onAnswerUser={answer} />);
	fireEvent.click(screen.getByRole("radio", { name: "Other…" }));
	const text = screen.getByRole("textbox");
	for (const value of [" \n ", "x".repeat(2001)]) {
		fireEvent.change(text, { target: { value } });
		expect(send().disabled).toBe(true);
	}
	fireEvent.change(text, { target: { value: "  third\nchoice " } });
	fireEvent.click(send());
	await waitFor(() => expect(send().disabled).toBe(false));
	expect(answer).toHaveBeenCalledExactlyOnceWith("u1", [{ questionId: "q1", other: "  third\nchoice " }]);
	expect((text as HTMLTextAreaElement).value).toBe("  third\nchoice ");
});

it.each(["Send answers", "Cancel"])("recovers from a rejected %s and retries with the draft", async (action) => {
	const answer = vi.fn().mockRejectedValueOnce(new Error("Transport failed")).mockResolvedValue(true);
	render(<QuestionCard item={item} onAnswerUser={answer} />);
	fireEvent.click(screen.getByRole("radio", { name: "Other…" }));
	const text = screen.getByRole("textbox") as HTMLTextAreaElement;
	const draft = "  third\nchoice ";
	fireEvent.change(text, { target: { value: draft } });
	fireEvent.click(screen.getByRole("button", { name: action }));
	await waitFor(() => expect(send().disabled).toBe(false));
	expect((text.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false);
	expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
	expect(text.value).toBe(draft);
	expect((screen.getByRole("radio", { name: "Other…" }) as HTMLInputElement).checked).toBe(true);
	expect(screen.getByRole("alert").textContent).toContain("Transport failed");
	const answers = [{ questionId: "q1", other: draft }];
	expect(answer).toHaveBeenNthCalledWith(1, "u1", action === "Cancel" ? null : answers);

	fireEvent.click(send());
	await waitFor(() => expect(answer).toHaveBeenCalledTimes(2));
	expect(answer).toHaveBeenNthCalledWith(2, "u1", answers);
	expect(send().disabled).toBe(true);
	expect(screen.queryByRole("alert")).toBeNull();
});

it("cancels without partial answers and replaces controls when the batch resolves", () => {
	const answer = vi.fn().mockResolvedValue(true);
	const view = render(<QuestionCard item={item} onAnswerUser={answer} />);
	fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
	expect(answer).toHaveBeenCalledExactlyOnceWith("u1", null);
	view.rerender(
		<QuestionCard item={{ ...item, state: "resolved", result: { status: "superseded" } }} onAnswerUser={answer} />,
	);
	expect(screen.queryByRole("button", { name: "Send answers" })).toBeNull();
	expect(screen.queryAllByRole("radio")).toHaveLength(0);
	expect(screen.getByText("Superseded by a new message")).toBeTruthy();
});
