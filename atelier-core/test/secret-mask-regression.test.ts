import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type AtelierEventBody, FakeBackend, FakeMemory, Session } from "../src/index.ts";

const finished: AtelierEventBody = {
	type: "turn_finished",
	stopReason: "end_turn",
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
};

// Item 2: narrowing to curl must preserve credentials masked before the change.
it.each([
	['"curl" -u ana:hunter2 https://example.test', '"curl" -u ana:[REDACTED] https://example.test'],
	['"/usr/bin/curl" --user ana:hunter2 x', '"/usr/bin/curl" --user ana:[REDACTED] x'],
	['echo "curl"; curl -u ana:hunter2 x', 'echo "curl"; curl -u ana:[REDACTED] x'],
	["curl -u ana\\:hunter2 x", "curl -u ana\\:[REDACTED] x"],
	// Other shell escapes: whatever the shell reads as the password is masked whole.
	["curl -u an\\a:pa\\ ss\\:w x", "curl -u an\\a:[REDACTED] x"],
	['curl -u "ana\\:p\\" w" x', 'curl -u "ana\\:[REDACTED]" x'],
	["curl -u $'ana:p\\' w' x", "curl -u $'ana:[REDACTED]' x"],
	["curl -u ana:$'p\\' w' x", "curl -u ana:[REDACTED] x"],
	["wget --password $'p\\' w' x", "wget --password [REDACTED] x"],
])("keeps masking curl credentials in %s", async (input, expected) => {
	const cwd = await mkdtemp(join(tmpdir(), "atelier-mask-regression-"));
	const memory = new FakeMemory("proj");
	const backend = new FakeBackend([[{ event: finished }]]);
	const session = await Session.start({ backend, memory, cwd, tools: [] });
	try {
		for await (const _ of session.send(input)) void _;
		expect(memory.prompts).toEqual([expected]);
	} finally {
		await session.close();
		await rm(cwd, { recursive: true, force: true });
	}
});
