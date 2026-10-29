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
