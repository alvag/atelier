import { expect, it, vi } from "vitest";
import { askUserOnTerminal } from "../src/ask-user-line.ts";

it("neutralizes Arabic Letter Mark in line questions, labels and descriptions", async () => {
	let output = "";
	const result = await askUserOnTerminal(
		[
			{
				id: "q1",
				question: "Q\u061C?",
				options: [
					{ id: "a", label: "L\u061C", description: "D\u061C", recommended: true },
					{ id: "b", label: "Second" },
				],
			},
		],
		{
			signal: new AbortController().signal,
			write: (text) => {
				output += text;
			},
			read: vi.fn().mockResolvedValue({ text: "1", pasted: false }),
			supersede: vi.fn(),
		},
	);
	expect(output).not.toContain("\u061C");
	for (const text of ["Q⟨U+061C⟩?", "L⟨U+061C⟩", "D⟨U+061C⟩"]) expect(output).toContain(text);
	expect(result).toEqual({ status: "answered", answers: [{ questionId: "q1", optionId: "a" }] });
});
