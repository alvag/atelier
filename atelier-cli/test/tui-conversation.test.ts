import type { AtelierEvent, AtelierEventBody } from "@atelier/core";
import { Container, stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Conversation } from "../src/tui/conversation.ts";
import { type Paint, painter, Shade } from "../src/tui/style.ts";

const plain = painter(false);
const usage = { input: 1200, output: 85, cacheRead: 0, cacheWrite: 0 };

/** When the turns of these tests end, and how the system says that time with hours and minutes. */
const FINISHED_AT = new Date(2026, 9, 27, 14, 42, 30);
const clock = () => FINISHED_AT;
const AT = FINISHED_AT.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

type Body = AtelierEventBody & { parentCallId?: string; agent?: string };
const stamp = (bodies: Body[]) => bodies.map((body, i) => ({ ...body, seq: i + 1, turnId: "t" }) as AtelierEvent);

function shown(bodies: Body[], width = 80, expanded = false) {
	const conversation = new Conversation(plain, "/repo", new Shade(false), clock);
	for (const event of stamp(bodies)) conversation.event(event);
	if (expanded) conversation.toggleCards();
	const lines = conversation.render(width);
	return { lines, text: lines.map((line) => line.trimEnd()).join("\n") };
}

describe("Conversation", () => {
	it("shows the agent's text as Markdown and the calls between two texts as one folded line", () => {
		const { text } = shown(
			[
				{ type: "text_delta", text: "Reading **the** " },
				{ type: "text_delta", text: "parser." },
				{ type: "tool_call_started", callId: "c1", tool: "read", input: { path: "src/args.ts" } },
				{ type: "tool_call_finished", callId: "c1", ok: true, summary: "src/args.ts (132 lines)", truncated: false },
				{ type: "tool_call_started", callId: "c2", tool: "bash", input: { command: "pnpm test\n--run" } },
				{ type: "tool_call_finished", callId: "c2", ok: true, summary: "pnpm test (exit 0)", truncated: false },
				{ type: "tool_call_started", callId: "c3", tool: "bash", input: { command: "git status" } },
				{ type: "tool_call_finished", callId: "c3", ok: true, summary: "git status (exit 0)", truncated: false },
				{ type: "tool_call_started", callId: "c4", tool: "edit", input: { path: "a.ts", edits: [] } },
				{ type: "tool_call_finished", callId: "c4", ok: true, summary: "a.ts (1 edit)", truncated: false },
				{ type: "tool_call_started", callId: "c5", tool: "edit", input: { path: "a.ts", edits: [] } },
				{ type: "tool_call_finished", callId: "c5", ok: true, summary: "a.ts (1 edit)", truncated: false },
				{ type: "tool_call_started", callId: "c6", tool: "grep", input: { pattern: "mode" } },
				{ type: "tool_call_finished", callId: "c6", ok: true, summary: "mode (3 matches)", truncated: false },
				{ type: "tool_call_started", callId: "c7", tool: "memory", input: { action: "search" } },
				{ type: "tool_call_finished", callId: "c7", ok: true, summary: "search (1 result)", truncated: false },
				{ type: "text_delta", text: "Done." },
			],
			120,
		);
		expect(text).toContain("Reading the parser.");
		expect(text).not.toContain("**");
		expect(text).toContain(
			"⎿ Ran 2 commands · read 1 file · edited 1 file · searched 1 time · used 1 other tool\n\n Done.",
		);
		expect(text).not.toContain("▸");
		expect(text).not.toContain("--run");
	});

	it("keeps a block's failures and what the sandbox blocked in sight while it is folded", () => {
		const { text } = shown([
			{ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "pnpm test" } },
			{ type: "tool_call_finished", callId: "c1", ok: false, summary: "pnpm test (exit 1)", truncated: false },
			{ type: "tool_call_started", callId: "c2", tool: "bash", input: { command: "pnpm install" } },
			{
				type: "tool_call_finished",
				callId: "c2",
				ok: true,
				summary: "pnpm install (exit 0)",
				truncated: false,
				blocked: ["network to registry.npmjs.org"],
			},
			{ type: "tool_call_started", callId: "c3", tool: "read", input: { path: "a.ts" } },
		]);
		expect(text).toContain("⎿ ◐ read a.ts…  (ran 2 commands)");
		expect(text).toContain("✗ bash pnpm test · exit 1");
		expect(text).toContain("sandbox blocked: network to registry.npmjs.org");
		expect(text).not.toContain("pnpm install");
	});

	it("shows the call running now in the summary's place, a subagent's own call included", () => {
		const { text } = shown([
			{ type: "tool_call_started", callId: "c1", tool: "read", input: { path: "a.ts" } },
			{ type: "tool_call_finished", callId: "c1", ok: true, summary: "a.ts (2 lines)", truncated: false },
			{ type: "tool_call_started", callId: "t1", tool: "task", input: { agent: "worker", prompt: "fix" } },
			{ type: "tool_call_started", callId: "k1", tool: "edit", input: { path: "b.ts" }, parentCallId: "t1" },
		]);
		expect(text).toContain("⎿ ◐ task worker · edit b.ts…  (read 1 file)");
		expect(text).not.toContain("Read 1 file");
	});

	it("leaves ODD's progress out of the transcript and says only when the task in progress changes", () => {
		const tasks = (now: string) => [
			{ id: "T1", title: "Parser", status: now === "T1" ? "in_progress" : "done", specs: [] },
			{ id: "T2", title: "Footer", status: now === "T2" ? "in_progress" : "pending", specs: [] },
		];
		const changed = (now: string): Body => ({
			type: "feature_changed",
			name: "tui",
			path: "odd/tasks/tui.md",
			title: "TUI",
			tasks: tasks(now) as never,
		});
		const { text } = shown([
			{ type: "tool_call_started", callId: "f1", tool: "feature", input: { action: "start" } },
			{ type: "tool_call_finished", callId: "f1", ok: true, summary: "start (2 tasks)", truncated: false },
			changed("T1"),
			changed("T1"),
			{ type: "tool_call_started", callId: "f2", tool: "feature", input: { action: "update_task" } },
			{ type: "tool_call_finished", callId: "f2", ok: false, summary: "update_task (no task T9)", truncated: false },
			changed("T2"),
		]);
		expect(text).not.toContain("done");
		expect(text).not.toContain("start");
		expect(text.match(/◆ now T1 Parser/g)).toHaveLength(1);
		expect(text).toContain("✗ feature update_task · no task T9");
		expect(text).toContain("◆ now T2 Footer");
	});

	it("expands every card to show the call's input and where its full output is", () => {
		const { text } = shown(
			[
				{ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "pnpm test\n--run" } },
				{
					type: "tool_call_finished",
					callId: "c1",
					ok: true,
					summary: "pnpm test (exit 0)",
					truncated: true,
					fullOutputPath: "/tmp/out.txt",
				},
				{
					type: "tool_call_started",
					callId: "c2",
					tool: "edit",
					input: { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] },
				},
				{ type: "tool_call_finished", callId: "c2", ok: true, summary: "a.ts (1 edit)", truncated: false },
			],
			80,
			true,
		);
		expect(text).toContain("⎿ ▾ Ran 1 command · edited 1 file");
		expect(text).toContain("▾ bash pnpm test · exit 0 ✓");
		expect(text).toContain("│ $ pnpm test\n     │ --run");
		expect(text).toContain("│ full output: /tmp/out.txt");
		expect(text).toContain("│ - old\n     │ + new");
	});

	it("groups a subagent's work under its task call, with its tools and cost", () => {
		const bodies: Body[] = [
			{ type: "tool_call_started", callId: "task1", tool: "task", input: { agent: "worker", prompt: "fix it" } },
			{
				type: "session_started",
				backend: "claude-code",
				model: "claude-sonnet-5-5",
				authSource: "subscription",
				parentCallId: "task1",
				agent: "worker",
			},
			{ type: "text_delta", text: "child text", parentCallId: "task1", agent: "worker" },
			{ type: "tool_call_started", callId: "k1", tool: "read", input: { path: "b.ts" }, parentCallId: "task1" },
			{
				type: "tool_call_finished",
				callId: "k1",
				ok: true,
				summary: "b.ts (3 lines)",
				truncated: false,
				parentCallId: "task1",
			},
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.04, parentCallId: "task1" },
			{ type: "tool_call_finished", callId: "task1", ok: true, summary: "worker (done)", truncated: false },
		];
		const folded = shown(bodies).text;
		expect(folded).toContain("⎿ Ran 1 subagent");
		expect(folded).not.toContain("$");
		expect(folded).not.toContain("child text");
		expect(folded).not.toContain("b.ts");
		const open = shown(bodies, 80, true).text;
		expect(open).toContain("▾ task worker · done ✓\n     └ worker · claude-sonnet-5-5 · 1 tool");
		expect(open).toContain("▸ read b.ts · 3 lines ✓");
		expect(open).toContain("child text");
	});

	it("groups the verifier's events under one line in the verification's card", () => {
		const { text } = shown([
			{ type: "verification_started", verifyId: "v1", items: [2], declaration: [{ items: [2], reason: "auth" }] },
			{
				type: "tool_call_started",
				callId: "k1",
				tool: "bash",
				input: { command: "pnpm test" },
				parentCallId: "v1",
				agent: "verify:verifier",
			},
			{
				type: "tool_call_finished",
				callId: "k1",
				ok: true,
				summary: "pnpm test (exit 0)",
				truncated: false,
				parentCallId: "v1",
				agent: "verify:verifier",
			},
			{ type: "verification_finished", verifyId: "v1", outcome: "passed", rounds: 1, openDefects: [], usage },
		]);
		expect(text).toContain("▸ verify · item 2\n   └ verify:verifier · 1 tool\n ✓ verify passed");
	});

	it("shows control characters in the agent's text and tool input as markers", () => {
		const { text } = shown([
			{ type: "text_delta", text: "hi \u001b[2J there" },
			{ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "echo ‮x" } },
		]);
		expect(text).toContain("hi ␛[2J there");
		expect(text).toContain("echo ⟨U+202E⟩x");
	});

	it("keeps review roles and their costs separate even with one review id", () => {
		const role = (agent: string, model: string, text: string, costUsd: number): Body[] => [
			{ type: "session_started", backend: "b", model, authSource: "subscription", agent, parentCallId: "r" },
			{ type: "text_delta", text, agent, parentCallId: "r" },
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd, agent, parentCallId: "r" },
		];
		const { text } = shown([
			...role("review:risk", "risk-model", "Risk report.", 0.01),
			...role("review:reliability", "reliability-model", "Reliability report.", 0.02),
		]);
		expect(text).toContain("review:risk · risk-model · 0 tools");
		expect(text).toContain("review:reliability · reliability-model · 0 tools");
		expect(text).not.toContain("$");
		expect(text).not.toContain("Risk report.Reliability report.");
	});

	it("expects a cache miss only in the compaction's turn and the next one", () => {
		const compacted: Body = {
			type: "compaction_finished",
			ok: true,
			reason: "manual",
			tokensBefore: 9000,
			kept: 1,
			usage,
		};
		const turn: Body = { type: "turn_finished", stopReason: "end_turn", usage };
		const miss: Body = { type: "cache_miss", reason: "system_changed", missedTokens: 100 };
		const soon = shown([compacted, turn, miss]).text;
		expect(soon).toContain("cache miss after compaction: system_changed (expected)");
		const late = shown([compacted, turn, turn, turn, miss]).text;
		expect(late).toContain("cache miss: system_changed (100 tokens not read from the cache)");
		expect(late).not.toContain("(expected)");
	});

	it("shows control characters of every event string as markers", () => {
		const esc = "x\u001b[31my";
		const { text } = shown([
			{ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: "ls" } },
			{ type: "tool_call_finished", callId: "c1", ok: false, summary: "ls (exit 1)", truncated: false, blocked: [esc] },
			{ type: "memory_status", available: true, project: esc },
			{ type: "memory_status", available: false, reason: esc },
			{ type: "project_instructions", files: [esc], dropped: [esc] },
			{ type: "skills_loaded", skills: [{ name: esc, path: esc }], warnings: [{ path: esc, message: esc }] },
			{ type: "review_status", available: false, reason: esc },
			{ type: "sandbox_status", sandboxed: false, mechanism: esc, reason: esc },
			{ type: "sandbox_warning", reason: esc },
			{ type: "cache_miss", reason: esc, missedTokens: 1 },
			{ type: "rate_limit", status: esc, window: esc },
			{ type: "error", code: esc, message: esc, recoverable: false },
			{ type: "phase_changed", phase: "planning", source: "inferred" },
		]);
		expect(text).toContain("x␛[31my");
		expect(text).not.toContain("\u001b");
	});

	it("leaves the phase to the footer", () => {
		expect(shown([{ type: "phase_changed", phase: "planning", source: "inferred" }]).text).toBe("");
	});

	it("keeps what the session loaded out of the transcript and gives it to /status, the newest of each", () => {
		const conversation = new Conversation(plain, "/repo");
		for (const event of stamp([
			{
				type: "session_started",
				backend: "claude-code",
				model: "claude-opus-5-5",
				authSource: "subscription",
				effort: "high",
				profile: { origin: "default", roles: { verifier: { model: "claude-sonnet-5-5" } } },
			},
			{ type: "sandbox_status", sandboxed: true, mechanism: "macOS seatbelt" },
			{ type: "project_instructions", files: ["/repo/AGENTS.md"], dropped: [] },
			{ type: "skills_loaded", skills: [{ name: "review", path: "/s/review" }], warnings: [] },
			{ type: "memory_status", available: true, project: "atelier" },
			{ type: "memory_status", available: true, project: "other" },
		]))
			conversation.event(event);
		expect(conversation.render(100).join("\n").trim()).toBe("");
		expect(conversation.status()).toEqual([
			"atelier · claude-code · claude-opus-5-5 · subscription · effort high",
			"profile default · verifier claude-sonnet-5-5",
			"bash: sandboxed (macOS seatbelt)",
			"instructions: /repo/AGENTS.md",
			"skills: review",
			"memory: other",
		]);
	});

	it("ends a turn's line with the local time it ended, also an interrupted one with nothing else to say", () => {
		const { text } = shown([
			{ type: "turn_finished", stopReason: "end_turn", usage, requests: 1, durationMs: 1800 },
			{ type: "turn_finished", stopReason: "interrupted", usage },
		]);
		expect(text).toContain(`◇ 1.8s · 1 request · ${AT}`);
		expect(text).toContain(`◇ interrupted · ${AT}`);
	});

	it("leaves one blank line between the prompt, the agent's text, each card, the turn's end and each note", () => {
		const conversation = new Conversation(plain, "/repo", new Shade(false), clock);
		conversation.prompt("hi");
		for (const event of stamp([
			{ type: "text_delta", text: "Hello." },
			{ type: "tool_call_started", callId: "c1", tool: "read", input: { path: "a.ts" } },
			{ type: "tool_call_finished", callId: "c1", ok: true, summary: "a.ts (2 lines)", truncated: false },
			{ type: "tool_call_started", callId: "c2", tool: "read", input: { path: "b.ts" } },
			{ type: "tool_call_finished", callId: "c2", ok: true, summary: "b.ts (3 lines)", truncated: false },
			{ type: "text_delta", text: "Done." },
			{ type: "turn_finished", stopReason: "end_turn", usage, requests: 1, durationMs: 1800 },
		]))
			conversation.event(event);
		conversation.prompt("/status");
		conversation.note("cost: none yet");
		// A session after it starts under its rule, with no blank lines doubled where two separations meet.
		const next = new Conversation(plain, "/repo");
		next.addChild(new Text("── new session ──", 1, 1));
		next.prompt("again");
		const transcript = new Container();
		transcript.addChild(conversation);
		transcript.addChild(next);
		expect(transcript.render(60).map((line) => line.trim())).toEqual([
			"❯ hi",
			"",
			"Hello.",
			"",
			"⎿ Read 2 files",
			"",
			"Done.",
			"",
			`◇ 1.8s · 1 request · ${AT}`,
			"",
			"❯ /status",
			"",
			"cost: none yet",
			"",
			"── new session ──",
			"",
			"❯ again",
			"",
		]);
	});

	it("leaves a blank line between the shaded prompt and the answer", () => {
		const conversation = new Conversation(painter(true), "/repo", new Shade(true));
		conversation.prompt("hi");
		conversation.event(stamp([{ type: "text_delta", text: "Hello." }])[0] as AtelierEvent);
		const lines = conversation.render(40).map((line) => stripTerminalSequences(line).trim());
		expect(lines).toEqual(["", "› hi", "", "", "Hello.", ""]);
		// The separation is the terminal's own background, under the shaded rows.
		expect(conversation.render(40)[3]).toBe("");
	});

	it("shows each prompt as a full-width block on the shade, after › and lined up on every line", () => {
		const conversation = new Conversation(painter(true), "/repo", new Shade(true));
		conversation.prompt("first line\nsecond line");
		const lines = conversation.render(40);
		const shaded = lines.filter((line) => line.startsWith("\x1b[100m"));
		expect(shaded.map((line) => stripTerminalSequences(line).trimEnd())).toEqual([
			"",
			"› first line",
			"  second line",
			"",
		]);
		for (const line of shaded) expect(visibleWidth(line)).toBe(40);
	});

	it("shows a prompt after ❯ as before without color", () => {
		const conversation = new Conversation(plain, "/repo", new Shade(false));
		conversation.prompt("first line\nsecond line");
		const text = conversation.render(40).join("\n");
		expect(text).toContain("❯ first line");
		expect(text).not.toContain("\x1b[");
	});

	it("shows control characters in what /status prints as markers", () => {
		const esc = "x\u001b[31my";
		const conversation = new Conversation(plain, "/repo");
		for (const event of stamp([
			{ type: "session_started", backend: "fake", model: esc, authSource: "subscription" },
			{ type: "sandbox_status", sandboxed: true, mechanism: esc },
			{ type: "project_instructions", files: [esc], dropped: [] },
			{ type: "skills_loaded", skills: [{ name: esc, path: esc }], warnings: [] },
			{ type: "memory_status", available: true, project: esc },
		]))
			conversation.event(event);
		const status = conversation.status().join("\n");
		expect(status.match(/x␛\[31my/g)).toHaveLength(5);
		expect(status).not.toContain("\u001b");
	});

	it("gives /status a later loss of the sandbox or the memory instead of what was there before", () => {
		const status = (bodies: Body[]) => {
			const conversation = new Conversation(plain, "/repo");
			for (const event of stamp(bodies)) conversation.event(event);
			return conversation.status();
		};
		const sandboxed: Body = { type: "sandbox_status", sandboxed: true, mechanism: "macOS seatbelt" };
		const remembering: Body = { type: "memory_status", available: true, project: "atelier" };
		expect(
			status([
				sandboxed,
				remembering,
				{ type: "sandbox_status", sandboxed: false, reason: "seatbelt failed" },
				{ type: "memory_status", available: false, reason: "offline" },
			]),
		).toEqual(["bash: not sandboxed (seatbelt failed)", "no memory: offline"]);
		expect(status([sandboxed, { type: "sandbox_warning", reason: "no seatbelt" }])).toEqual([
			"bash: not sandboxed (no seatbelt)",
		]);
	});

	it("still shows the warnings and what runs with less protection", () => {
		const { text } = shown([
			{ type: "session_started", backend: "claude-code", model: "m", authSource: "api_key", permissionMode: "yolo" },
			{ type: "sandbox_status", sandboxed: false, reason: "no bwrap" },
			{ type: "review_status", available: false, reason: "ATELIER_REVIEW=off" },
			{ type: "project_instructions", files: ["/repo/AGENTS.md"], dropped: ["/repo/BIG.md"] },
			{
				type: "skills_loaded",
				skills: [{ name: "ok", path: "/s/ok" }],
				warnings: [{ path: "/s/bad", message: "no name" }],
			},
			{ type: "memory_status", available: false, reason: "offline" },
		]);
		expect(text).toContain("mode: yolo · what normal mode would ask runs without asking");
		expect(text).toContain("warning: not using a Claude subscription (auth: api_key)");
		expect(text).toContain("bash: not sandboxed (no bwrap)");
		expect(text).toContain("no review: ATELIER_REVIEW=off");
		expect(text).toContain("instructions over 32 KiB, left out: /repo/BIG.md");
		expect(text).toContain("skill /s/bad: no name");
		expect(text).toContain("no memory: offline");
		expect(text).not.toContain("atelier · claude-code");
		expect(text).not.toContain("instructions: ");
		expect(text).not.toContain("skills: ");
	});

	it("says what a turn took and its phases, without prices", () => {
		const agent = { role: "main", backend: "claude-code", model: "claude-opus-5-5", effort: "high" as const };
		const { text } = shown(
			[
				{ type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "subscription" },
				{ type: "compaction_finished", ok: true, reason: "manual", tokensBefore: 9000, kept: 1, usage, costUsd: 0.01 },
				{
					type: "turn_finished",
					stopReason: "end_turn",
					usage,
					costUsd: 0.0421,
					requests: 3,
					durationMs: 12_300,
					phases: {
						main: { usage, requests: 2, costUsd: 0.04, agents: [agent] },
						verify: { usage, costUsd: 0.0021, agents: [{ ...agent, role: "verifier", backend: "codex" }] },
					},
				},
			],
			200,
		);
		expect(text).toContain("◇ context compacted: 9,000 tokens before · 1 message kept");
		expect(text).toContain(
			`◇ 12.3s · 3 requests · ${AT}\n phases: main 2 req on claude-opus-5-5 high · verify 1,285 tokens on codex/claude-opus-5-5 high`,
		);
		expect(text).not.toContain("$");
	});

	it("never renders a line wider than the terminal", () => {
		const long = "x".repeat(300);
		const { lines } = shown(
			[
				{ type: "text_delta", text: long },
				{ type: "tool_call_started", callId: "c1", tool: "bash", input: { command: long } },
				{
					type: "tool_call_finished",
					callId: "c1",
					ok: true,
					summary: `${long} (exit 0)`,
					truncated: false,
					blocked: [long],
				},
			],
			40,
			true,
		);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});
});

describe("Conversation code blocks", () => {
	/** Marks each painted piece with its style, so a test sees which color each token asked for. */
	const tagged: Paint = (style, text) => `<${[style].flat().join("+")}>${text}</>`;
	const untag = (line: string) => line.replace(/<[^>]*>/g, "");

	function codeLines(markdown: string, paint: Paint) {
		const conversation = new Conversation(paint, "/repo");
		for (const event of stamp([{ type: "text_delta", text: markdown }])) conversation.event(event);
		const lines = conversation.render(80).map((line) => line.trimEnd());
		const open = lines.findIndex((line) => line.includes("```"));
		const close = lines.findIndex((line, i) => i > open && line.includes("```"));
		return lines.slice(open + 1, close);
	}

	it("colors the tokens of a block with a language and keeps its text", () => {
		const source = 'const name = "atelier"; // the app\nreturn 42;';
		const lines = codeLines(`\`\`\`ts\n${source}\n\`\`\``, tagged);
		const text = lines.join("\n");
		expect(text).toContain("<magenta>const</>");
		expect(text).toContain('<green>"atelier"</>');
		expect(text).toContain("<dim>// the app</>");
		expect(text).toContain("<yellow>42</>");
		expect(lines.map((line) => untag(line).trim())).toEqual(source.split("\n"));
	});

	it("colors bash and json blocks", () => {
		expect(codeLines('```bash\necho "hi" # greet\n```', tagged).join("\n")).toContain("<dim># greet</>");
		expect(codeLines('```json\n{ "port": 8080 }\n```', tagged).join("\n")).toContain("<yellow>8080</>");
	});

	it("leaves a block without a language or with an unknown one as plain text", () => {
		for (const fence of ["```", "```klingon"]) {
			const lines = codeLines(`${fence}\nconst x = "y"; // z\n\`\`\``, tagged);
			expect(lines.map((line) => line.trim())).toEqual(['const x = "y"; // z']);
		}
	});

	it("adds no escape when the terminal has no color", () => {
		const lines = codeLines('```ts\nconst x = "y"; // z\n```', painter(false));
		expect(lines.map((line) => line.trim())).toEqual(['const x = "y"; // z']);
		expect(lines.join("\n")).not.toContain("\x1b[");
	});

	it("closes every color on its own line in a token that spans lines", () => {
		const lines = codeLines("```ts\n/* one\n   two */\nlet a = `x\ny`;\n```", tagged);
		expect(lines.map(untag).map((line) => line.trim())).toEqual(["/* one", "two */", "let a = `x", "y`;"]);
		for (const line of lines) expect(line.match(/<[^/>]+>/g)?.length).toBe(line.match(/<\/>/g)?.length);
		expect(lines[1]).toContain("<dim>   two */</>");
	});
});
