import type { UserQuestion } from "@atelier/core";
import { expect, it } from "vitest";
import { AnsweredBlock } from "../src/tui/answered-block.ts";
import { painter } from "../src/tui/style.ts";

const plain = painter(false);

const checks = (id: string, question: string): UserQuestion => ({
	id,
	question,
	multiSelect: true,
	options: [
		{ id: "biome", label: "Biome" },
		{ id: "tsc", label: "TypeScript" },
	],
});

it("says a multi-select answer as its labels, the user's own text after them, or none", () => {
	const questions = [checks("checks", "Which checks?"), checks("docs", "Which docs?"), checks("extras", "Extras?")];
	const block = new AnsweredBlock(
		questions,
		{
			status: "answered",
			answers: [
				{ questionId: "checks", optionIds: ["tsc", "biome"] },
				{ questionId: "docs", optionIds: ["biome"], other: "also\nthe README" },
				{ questionId: "extras", optionIds: [] },
			],
		},
		plain,
	);
	expect(block.render(120)).toEqual([
		" ● Answered 3 questions",
		"   ⎿ Which checks?  → TypeScript, Biome",
		"     Which docs?    → Biome, Type something: also the README",
		"     Extras?        → none",
	]);
});
