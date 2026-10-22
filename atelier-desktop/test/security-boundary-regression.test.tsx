// @vitest-environment jsdom
// Regressions found by the independent verification of U5 (S5).
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { parseCommand } from "../src/main/guards.ts";
import { Transcript } from "../src/renderer/src/chat/Transcript.tsx";

function approvalCard(command: string): HTMLElement {
	const html = renderToStaticMarkup(
		<Transcript
			turns={[{ prompt: "", items: [{ kind: "approval", callId: "c", state: "pending", command }] }]}
			onAnswer={() => {}}
		/>,
	);
	const div = document.createElement("div");
	div.innerHTML = html;
	return div.querySelector(".approval") as HTMLElement;
}

it("returns invalid_command for circular IPC data", () => {
	const payload: Record<string, unknown> = { command: "shutdown" };
	payload.self = payload;
	expect(() => parseCommand(structuredClone(payload))).not.toThrow();
	expect(parseCommand(payload)).toMatchObject({ ok: false, error: { code: "invalid_command" } });
	expect(parseCommand({ command: "shutdown", big: 10n })).toMatchObject({
		ok: false,
		error: { code: "invalid_command" },
	});
});

it("exposes approval bidi controls visibly instead of interpreting them", () => {
	const card = approvalCard("printf '%s' '\u202E'; touch /tmp/approved #\u202C");
	const shown = card.querySelector("pre")?.textContent ?? "";
	expect(shown).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
	expect(shown).toContain("⟨U+202E⟩");
	expect(shown).toContain("touch /tmp/approved");
	expect(card.textContent).toContain("This command contains invisible or control characters");
});

it("shows control characters and zero-width characters too", () => {
	const shown = approvalCard("echo a\u200Bb \u001b[31mred").querySelector("pre")?.textContent ?? "";
	expect(shown).toBe("echo a⟨U+200B⟩b ␛[31mred");
});

it("does not warn about an ordinary command", () => {
	const card = approvalCard("npm test -- --watch=false");
	expect(card.querySelector("pre")?.textContent).toBe("npm test -- --watch=false");
	expect(card.textContent).not.toContain("invisible");
});
