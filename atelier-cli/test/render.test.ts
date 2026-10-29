import { type AtelierEvent, type AtelierEventBody, visibleText } from "@atelier/core";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { Renderer } from "../src/render.ts";

function render(bodies: (AtelierEventBody & { parentCallId?: string; agent?: string })[], cwd?: string) {
	let stdout = "";
	let stderr = "";
	const renderer = new Renderer({
		stdout: (s) => (stdout += s),
		stderr: (s) => (stderr += s),
		color: false,
		...(cwd === undefined ? {} : { cwd }),
	});
	for (const [i, body] of bodies.entries()) renderer.render({ ...body, seq: i + 1, turnId: "t" } as AtelierEvent);
	return { stdout, stderr, renderer };
}

const usage = { input: 1200, output: 85, cacheRead: 9000, cacheWrite: 3100 };

describe("Renderer", () => {
	it("streams text, one line per tool and the turn's tokens", () => {
		const { stdout, stderr } = render([
			{ type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "subscription" },
			{ type: "thinking_delta", text: "hmm" },
			{ type: "text_delta", text: "Let me " },
			{ type: "text_delta", text: "look." },
			{ type: "tool_call_started", callId: "c1", tool: "read", input: { path: "src/user.ts" } },
			{ type: "tool_call_finished", callId: "c1", ok: true, summary: "src/user.ts (12 lines)", truncated: false },
			{ type: "tool_call_started", callId: "c2", tool: "bash", input: { command: "npm test" } },
			{ type: "tool_call_finished", callId: "c2", ok: false, summary: "npm test (exit 1)", truncated: true },
			{ type: "text_delta", text: "Fixed." },
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.0421 },
		]);
		expect(stdout).toBe(
			[
				"atelier · claude-code · claude-opus-5-5 · subscription",
				"Let me look.",
				"▸ read src/user.ts (12 lines) ✓",
				"▸ bash npm test (exit 1) ✗ (truncated)",
				"Fixed.",
				"tokens: input 1,200 · output 85 · cache read 9,000 · cache write 3,100 · cache 68% · $0.0421",
				"",
			].join("\n"),
		);
		expect(stderr).toBe("");
	});

	it("says what a memory call did and how it came out", () => {
		const call = (callId: string, input: Record<string, string | number>, ok: boolean, summary: string) =>
			[
				{ type: "tool_call_started", callId, tool: "memory", input },
				{ type: "tool_call_finished", callId, ok, summary, truncated: false },
			] as const;
		const { stdout } = render([
			...call("m1", { action: "search", query: "tui\ncards" }, true, "2 results"),
			...call("m2", { action: "get", id: 7 }, true, "#7 [decision] Use MCP"),
			...call("m3", { action: "save", title: "Cards", type: "decision" }, true, "Saved memory #8. Warning: slow"),
			...call("m4", { action: "get", id: 9 }, false, "No memory #9."),
		]);
		expect(stdout).toBe(
			[
				'▸ memory search "tui cards" · 2 results ✓',
				"▸ memory get #7 · [decision] Use MCP ✓",
				'▸ memory save "Cards" · saved #8 · warning: slow ✓',
				"▸ memory get #9 · No memory #9. ✗",
				"",
			].join("\n"),
		);
	});

	it("says the session summary was saved as a memory call does, its warning once", () => {
		const { stdout, stderr } = render([
			{ type: "memory_summary_saved", id: 5519, preview: "## Goal" },
			{ type: "memory_summary_saved", id: 5519, preview: "## Goal", warning: "slow" },
			{
				type: "error",
				code: "memory_summary_warning",
				message: "The compaction summary was saved to memory with a warning: slow",
				recoverable: true,
			},
		]);
		expect(stdout).toBe(
			[
				'▸ memory session summary "## Goal" · saved #5519 ✓',
				'▸ memory session summary "## Goal" · saved #5519 · warning: slow ✓',
				"",
			].join("\n"),
		);
		expect(stderr).toBe("");
	});

	it("cuts the session summary's first line to 120 columns, by width", () => {
		const wide = "界".repeat(100);
		const combining = "é".repeat(80);
		const { stdout } = render([
			{ type: "memory_summary_saved", id: 1, preview: wide },
			{ type: "memory_summary_saved", id: 2, preview: combining },
		]);
		const [first = "", second] = stdout.split("\n");
		const quoted = /"(.*)"/.exec(first)?.[1] ?? "";
		expect(quoted).toBe(`${"界".repeat(59)}…`);
		expect(visibleWidth(quoted)).toBe(119);
		expect(second).toBe(`▸ memory session summary "${combining}" · saved #2 ✓`);
	});

	describe("the sandbox", () => {
		it("says on stdout that bash is sandboxed", () => {
			const { stdout, stderr } = render([{ type: "sandbox_status", sandboxed: true, mechanism: "macOS seatbelt" }]);
			expect(stdout).toBe("bash: sandboxed (macOS seatbelt)\n");
			expect(stderr).toBe("");
		});

		it("warns on stderr, with the reason, that bash is not sandboxed", () => {
			const { stdout, stderr } = render([
				{ type: "sandbox_status", sandboxed: false, reason: "sandbox not available on this platform" },
			]);
			expect(stdout).toBe("");
			expect(stderr).toBe(
				"bash: not sandboxed (sandbox not available on this platform): every command asks for approval in normal mode, and goes to the classifier in auto mode\n",
			);
		});

		it("does not repeat the warning in the turn that already said it, but says it in the next turns", () => {
			let stderr = "";
			const renderer = new Renderer({ stdout: () => {}, stderr: (s) => (stderr += s), color: false });
			const events: [string, AtelierEventBody][] = [
				["t1", { type: "sandbox_status", sandboxed: false, reason: "r" }],
				["t1", { type: "sandbox_warning", reason: "r" }],
				["t2", { type: "sandbox_warning", reason: "r" }],
			];
			for (const [i, [turnId, body]] of events.entries())
				renderer.render({ ...body, seq: i + 1, turnId } as AtelierEvent);
			expect(stderr).toBe(
				[
					"bash: not sandboxed (r): every command asks for approval in normal mode, and goes to the classifier in auto mode",
					"warning: bash runs without a sandbox (r): every command asks for approval in normal mode, and goes to the classifier in auto mode",
					"",
				].join("\n"),
			);
		});

		it("lists what the sandbox blocked under the tool line, also for a subagent", () => {
			const { stdout } = render([
				{ type: "tool_call_started", callId: "c1", tool: "bash", input: {} },
				{
					type: "tool_call_finished",
					callId: "c1",
					ok: false,
					summary: "touch /x (exit 1)",
					truncated: false,
					blocked: ["write to /x (not an allowed write path)", "and 2 more"],
				},
				{ type: "tool_call_started", callId: "c2", tool: "bash", input: {}, parentCallId: "p", agent: "worker" },
				{
					type: "tool_call_finished",
					callId: "c2",
					ok: false,
					summary: "cat /k (exit 1)",
					truncated: false,
					blocked: ["read of /k (denied by the sandbox policy)"],
					parentCallId: "p",
					agent: "worker",
				},
			]);
			expect(stdout).toBe(
				[
					"▸ bash touch /x (exit 1) ✗",
					"  sandbox blocked: write to /x (not an allowed write path)",
					"  sandbox blocked: and 2 more",
					"  │ ▸ bash cat /k (exit 1) ✗",
					"  │   sandbox blocked: read of /k (denied by the sandbox policy)",
					"",
				].join("\n"),
			);
		});
	});

	describe("permission_classified", () => {
		it("prints what the classifier decided, a subagent's indented, and shows hidden characters in its reason", () => {
			const { stdout } = render([
				{ type: "permission_classified", callId: "c1", decision: "allow", reason: "installs what was asked" },
				{ type: "permission_classified", callId: "c2", decision: "deny", reason: "publishes\u001b[31m" },
				{ type: "permission_classified", callId: "c3", decision: "undecided", reason: "classifier unavailable: boom" },
				{
					type: "permission_classified",
					callId: "c4",
					decision: "allow",
					reason: "ok",
					parentCallId: "p",
					agent: "worker",
				},
			]);
			expect(stdout).toBe(
				[
					"  auto: allowed — installs what was asked",
					"  auto: denied — publishes␛[31m",
					"  auto: undecided — classifier unavailable: boom; asking you",
					"  │   auto: allowed — ok",
					"",
				].join("\n"),
			);
		});
	});

	it("says the effort and the frozen profile, with its origin and what it sets for each role", () => {
		const { stdout } = render([
			{
				type: "session_started",
				backend: "anthropic-api",
				model: "claude-opus-5-5",
				authSource: "api_key",
				effort: "high",
				profile: {
					name: "cheap",
					origin: "local-pin",
					roles: {
						explorer: { thinking: "low" },
						verifier: { backend: "claude-code", model: "claude-sonnet-5-5", thinking: "medium" },
					},
				},
			},
		]);
		expect(stdout).toBe(
			[
				"atelier · anthropic-api · claude-opus-5-5 · api_key · effort high",
				"profile cheap (local-pin) · explorer thinking low · verifier claude-code/claude-sonnet-5-5 thinking medium",
				"",
			].join("\n"),
		);
	});

	it("says the default profile only by its origin, and nothing without a profile", () => {
		const started = { type: "session_started", backend: "anthropic-api", model: "m", authSource: "api_key" } as const;
		expect(render([{ ...started, profile: { origin: "default", roles: {} } }]).stdout).toBe(
			"atelier · anthropic-api · m · api_key\nprofile default\n",
		);
		expect(render([started]).stdout).toBe("atelier · anthropic-api · m · api_key\n");
	});

	it("repeats the profile in a later header, even when that session_started carries none", () => {
		const started = {
			type: "session_started",
			backend: "claude-code",
			model: "m",
			authSource: "subscription",
		} as const;
		const profile = { name: "cheap", origin: "repo", roles: { explorer: { thinking: "low" } } } as const;
		const header = "atelier · claude-code · m · subscription\nprofile cheap (repo) · explorer thinking low\n";
		expect(
			render([
				{ ...started, profile },
				{ ...started, profile },
			]).stdout,
		).toBe(header + header);
		expect(render([{ ...started, profile }, started]).stdout).toBe(header + header);
	});

	it("warns when the session is not using a subscription", () => {
		const { stderr } = render([{ type: "session_started", backend: "claude-code", model: "m", authSource: "api_key" }]);
		expect(stderr).toBe("warning: not using a Claude subscription (auth: api_key); usage may be billed separately.\n");
	});

	it("does not warn about billing on anthropic-api or opencode-go, which are billed to their key on purpose", () => {
		const { stderr } = render([
			{ type: "session_started", backend: "anthropic-api", model: "claude-sonnet-5-5", authSource: "api_key" },
			{ type: "session_started", backend: "opencode-go", model: "minimax-m3", authSource: "api_key" },
		]);
		expect(stderr).toBe("");
	});

	it("shows the requests of a turn and why the cache missed", () => {
		const { stdout, stderr } = render([
			{ type: "cache_miss", reason: "system_changed", missedTokens: 4200 },
			{ type: "turn_finished", stopReason: "end_turn", usage, costUsd: 0.0421, requests: 3 },
		]);
		expect(stdout).toBe(
			"tokens: input 1,200 · output 85 · cache read 9,000 · cache write 3,100 · cache 68% · 3 requests · $0.0421\n",
		);
		expect(stderr).toBe("cache miss: system_changed (4,200 tokens not read from the cache)\n");
	});

	it("shows the turn's cost by phase on a line under the total, only when the turn had more than one", () => {
		const part = (input: number) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0 });
		const { stdout } = render([
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				costUsd: 0.0421,
				requests: 3,
				phases: {
					main: { usage: part(1000), requests: 1, costUsd: 0.04 },
					verify: { usage: part(150), costUsd: 0.0021 },
					lenses: { usage: part(40), requests: 2 },
					validator: { usage: part(9) },
				},
			},
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				phases: { main: { usage } },
			},
		]);
		expect(stdout).toBe(
			[
				"tokens: input 1,200 · output 85 · cache read 9,000 · cache write 3,100 · cache 68% · 3 requests · $0.0421",
				"phases: main $0.0400 (1 req) · verify $0.0021 · lenses 2 req · validator 10 tokens",
				"tokens: input 1,200 · output 85 · cache read 9,000 · cache write 3,100 · cache 68%",
				"",
			].join("\n"),
		);
	});

	it("says on the phases line each part's models and efforts, and the backend only when it is not the session's", () => {
		const part = (input: number) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0 });
		const agent = (role: string, backend: string, model: string, effort?: "medium" | "high") => ({
			role,
			backend,
			model,
			...(effort === undefined ? {} : { effort }),
		});
		const { stdout } = render([
			{ type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "subscription" },
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				phases: {
					main: {
						usage: part(1000),
						requests: 1,
						costUsd: 0.04,
						agents: [agent("orchestrator", "claude-code", "claude-opus-5-5", "high")],
					},
					verify: { usage: part(150), costUsd: 0.0021, agents: [agent("verifier", "codex", "gpt-5.5", "medium")] },
					lenses: {
						usage: part(40),
						requests: 2,
						agents: [
							agent("review-risk", "claude-code", "claude-sonnet-5-5", "medium"),
							agent("review-reliability", "claude-code", "claude-sonnet-5-5", "medium"),
							agent("review-readability", "claude-code", "claude-haiku-5-5"),
						],
					},
					validator: { usage: part(9) },
				},
			},
		]);
		expect(stdout.split("\n").find((line) => line.startsWith("phases:"))).toBe(
			"phases: main $0.0400 (1 req) on claude-opus-5-5 high · verify $0.0021 on codex/gpt-5.5 medium · lenses 2 req on claude-sonnet-5-5 medium, claude-haiku-5-5 · validator 10 tokens",
		);
	});

	it("says on the phases line the effort the backend applied when no level was asked, apart from an asked one", () => {
		const part = (input: number) => ({ input, output: 1, cacheRead: 0, cacheWrite: 0 });
		const { stdout } = render([
			{ type: "session_started", backend: "claude-code", model: "claude-opus-5-5", authSource: "subscription" },
			{
				type: "turn_finished",
				stopReason: "end_turn",
				usage,
				phases: {
					main: {
						usage: part(1000),
						requests: 1,
						agents: [
							{ role: "orchestrator", backend: "claude-code", model: "claude-opus-5-5", effectiveEffort: "xhigh" },
						],
					},
					verify: {
						usage: part(150),
						requests: 1,
						agents: [{ role: "verifier", backend: "claude-code", model: "claude-sonnet-5-5", effort: "medium" }],
					},
				},
			},
		]);
		expect(stdout.split("\n").find((line) => line.startsWith("phases:"))).toBe(
			"phases: main 1 req on claude-opus-5-5 effective xhigh · verify 1 req on claude-sonnet-5-5 medium",
		);
	});

	it("indents a subagent's work under a header, without failing the parent's turn", () => {
		const child = (body: Record<string, unknown>) =>
			({ ...body, parentCallId: "c1", agent: "explorer" }) as unknown as AtelierEventBody;
		const { stdout, stderr, renderer } = render([
			{ type: "tool_call_started", callId: "c1", tool: "task", input: { agent: "explorer", prompt: "Find it." } },
			child({ type: "session_started", backend: "claude-code", model: "haiku", authSource: "api_key" }),
			child({ type: "tool_call_started", callId: "r1", tool: "read", input: { path: "a.ts" } }),
			child({ type: "tool_call_finished", callId: "r1", ok: true, summary: "a.ts (3 lines)", truncated: false }),
			// A blank line split across deltas, as streaming often sends it.
			child({ type: "text_delta", text: "Found\n" }),
			child({ type: "text_delta", text: "\nit." }),
			child({ type: "error", code: "x", message: "child hiccup", recoverable: false }),
			child({
				type: "turn_finished",
				stopReason: "error",
				usage: { input: 40, output: 8, cacheRead: 0, cacheWrite: 0 },
				requests: 2,
			}),
			{ type: "tool_call_finished", callId: "c1", ok: true, summary: "explorer: 9 characters", truncated: false },
		]);
		expect(stdout).toBe(
			[
				"  ↳ explorer · haiku",
				"  │ ▸ read a.ts (3 lines) ✓",
				"  │ Found",
				"  │",
				"  │ it.",
				"  │ tokens: input 40 · output 8 · cache read 0 · cache write 0 · cache 0% · 2 requests",
				"▸ task explorer: 9 characters ✓",
				"",
			].join("\n"),
		);
		expect(stderr).toBe("  │ error: child hiccup\n");
		expect(renderer.failed).toBe(false);
	});

	it("prints the phase when it changes and the feature's progress", () => {
		const { stdout, stderr } = render([
			{ type: "phase_changed", phase: "planning", source: "inferred" },
			{
				type: "feature_changed",
				name: "slug-accents",
				path: "odd/tasks/slug-accents.md",
				title: "Slug accents",
				tasks: [
					{ id: "T1", title: "Transliterate", specs: ["S1"], status: "done", commit: "abc1234" },
					{ id: "T2", title: "Run the tests", specs: ["S1"], status: "in_progress" },
					{ id: "T3", title: "Docs", specs: ["S1"], status: "pending" },
				],
			},
			{ type: "phase_changed", phase: "closing", source: "declared" },
		]);
		expect(stdout).toBe(
			[
				"· planning",
				"◆ Slug accents (odd/tasks/slug-accents.md): 1/3 done · now T2 Run the tests",
				"· closing",
				"",
			].join("\n"),
		);
		expect(stderr).toBe("");
	});

	it("says which memory the session uses, or why it has none", () => {
		const on = render([{ type: "memory_status", available: true, project: "atelier" }]);
		expect(on.stdout).toBe("memory: atelier\n");
		const off = render([
			{ type: "memory_status", available: false, reason: "Engram is not installed (no engram command)." },
		]);
		expect(off.stdout).toBe("");
		expect(off.stderr).toBe("no memory: Engram is not installed (no engram command).\n");
	});

	it("shows a tool's name and summary with markers for control characters, also a subagent's", () => {
		const { stdout } = render([
			{ type: "tool_call_started", callId: "c1", tool: "mcp_\x1b[31mcall", input: {} },
			{ type: "tool_call_finished", callId: "c1", ok: true, summary: "docs › se\x1b[2Jarch", truncated: false },
			{
				type: "tool_call_started",
				callId: "c2",
				tool: "re\x1b[31mad",
				input: {},
				parentCallId: "p",
				agent: "explorer",
			},
			{
				type: "tool_call_finished",
				callId: "c2",
				ok: true,
				summary: "f\x1b[2Jile",
				truncated: false,
				parentCallId: "p",
				agent: "explorer",
			},
		]);
		expect(stdout).not.toContain("\x1b");
		expect(stdout).toContain(`▸ ${visibleText("mcp_\x1b[31mcall").text} ${visibleText("docs › se\x1b[2Jarch").text} ✓`);
		expect(stdout).toContain(visibleText("re\x1b[31mad").text);
	});

	it("says which MCP servers are up, and warns about failed and invalid ones and the file's problems", () => {
		const { stdout, stderr } = render([
			{
				type: "mcp_status",
				servers: [
					{ name: "docs", transport: "http", state: "connected", tools: ["search", "read"] },
					{ name: "one", transport: "stdio", state: "connected", tools: ["only"] },
					{ name: "fs", transport: "stdio", state: "connecting", tools: [] },
					{ name: "off", transport: "stdio", state: "disabled", tools: [] },
					{ name: "ctx", transport: "stdio", state: "failed", tools: [], error: "spawn npx ENOENT\nmore", stderr: "x" },
					{ name: "bad", state: "invalid", tools: [], error: '"timeout" must be a positive number of seconds' },
					{
						name: "jira",
						transport: "http",
						state: "needs_auth",
						tools: [],
						error: "sign-in required: run atelier mcp login jira",
					},
				],
				problems: ["/h/.atelier/mcp.json is not valid JSON: Unexpected token"],
			},
		]);
		expect(stdout).toBe("mcp: docs (2 tools), one (1 tool), fs (connecting)\n");
		expect(stderr).toBe(
			[
				"mcp: ctx failed: spawn npx ENOENT (/mcp for details)",
				'mcp: bad is invalid: "timeout" must be a positive number of seconds',
				"mcp: jira needs sign-in: run atelier mcp login jira",
				"mcp: /h/.atelier/mcp.json is not valid JSON: Unexpected token",
				"",
			].join("\n"),
		);
	});

	it("says which instruction files were loaded, and warns about those the cap left out", () => {
		const on = render([{ type: "project_instructions", files: ["/w/AGENTS.md", "/w/p/CLAUDE.md"], dropped: [] }]);
		expect(on.stdout).toBe("instructions: /w/AGENTS.md, /w/p/CLAUDE.md\n");
		expect(on.stderr).toBe("");
		const cut = render([{ type: "project_instructions", files: ["/w/p/AGENTS.md"], dropped: ["/w/AGENTS.md"] }]);
		expect(cut.stdout).toBe("instructions: /w/p/AGENTS.md\n");
		expect(cut.stderr).toBe("instructions over 32 KiB, left out: /w/AGENTS.md\n");
	});

	it("says which skills were loaded, and warns about each problem", () => {
		const both = render([
			{
				type: "skills_loaded",
				skills: [
					{ name: "pdf", path: "/w/.agents/skills/pdf/SKILL.md" },
					{ name: "notes", path: "/h/.agents/skills/notes/SKILL.md" },
				],
				warnings: [
					{ path: "/w/.agents/skills/a/SKILL.md", message: "no description; not loaded" },
					{ path: "/h/.agents/skills/pdf/SKILL.md", message: 'skill "pdf" is already loaded' },
				],
			},
		]);
		expect(both.stdout).toBe("skills: pdf, notes\n");
		expect(both.stderr).toBe(
			'skill /w/.agents/skills/a/SKILL.md: no description; not loaded\nskill /h/.agents/skills/pdf/SKILL.md: skill "pdf" is already loaded\n',
		);
		const evil = "evil\u001b[31mRED\u001b]0;PWNED\u0007\u001b[2J";
		const hostile = render([
			{
				type: "skills_loaded",
				skills: [{ name: evil, path: `/w/${evil}/SKILL.md` }],
				warnings: [{ path: `/w/${evil}/SKILL.md`, message: `name "${evil}" should be lowercase` }],
			},
		]);
		expect(hostile.stdout).toBe("skills: evil␛[31mRED␛]0;PWNED⟨U+0007⟩␛[2J\n");
		expect(hostile.stderr).not.toContain("\u001b");
		expect(hostile.stderr).not.toContain("\u0007");
		expect(hostile.stderr).toContain("␛]0;PWNED⟨U+0007⟩");
		const warned = render([{ type: "skills_loaded", skills: [], warnings: [{ path: "/s/SKILL.md", message: "m" }] }]);
		expect(warned.stdout).toBe("");
		expect(warned.stderr).toBe("skill /s/SKILL.md: m\n");
	});

	it("prints errors to stderr and remembers them", () => {
		const { stdout, stderr, renderer } = render([
			{ type: "text_delta", text: "partial" },
			{ type: "error", code: "not_logged_in", message: "Claude Code is not logged in.", recoverable: false },
			{ type: "turn_finished", stopReason: "error", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		]);
		expect(stdout).toBe("partial\ntokens: input 0 · output 0 · cache read 0 · cache write 0\n");
		expect(stderr).toBe("error: Claude Code is not logged in.\n");
		expect(renderer.failed).toBe(true);
	});

	it("does not count recoverable errors as a failed turn", () => {
		const { renderer } = render([
			{ type: "error", code: "busy", message: "busy", recoverable: true },
			{ type: "turn_finished", stopReason: "end_turn", usage },
		]);
		expect(renderer.failed).toBe(false);
	});

	it("shows rate limits only when they matter", () => {
		const quiet = render([{ type: "rate_limit", status: "allowed", window: "five_hour" }]);
		expect(quiet.stderr).toBe("");
		const loud = render([{ type: "rate_limit", status: "allowed_warning", window: "five_hour", resetsAt: 1792000000 }]);
		expect(loud.stderr).toMatch(/^rate limit: allowed_warning \(five_hour, resets .+\)\n$/);
	});

	describe("review", () => {
		const finished: Extract<AtelierEventBody, { type: "review_finished" }> = {
			type: "review_finished",
			reviewId: "r1",
			verdict: "approved",
			findings: [],
			refuted: [],
			followUps: [],
			correction: null,
			usage,
		};
		const finding = {
			id: "RL-001",
			lens: "reliability",
			severity: "critical",
			cause: "candidate",
			path: "src/auth.ts",
			line: 12,
			claim: "The token is dropped.",
			evidence: "src/auth.ts:12",
		};

		it("warns when there is no review, like memory", () => {
			const { stdout, stderr } = render([{ type: "review_status", available: false, reason: "not a git repository" }]);
			expect(stdout).toBe("");
			expect(stderr).toBe("no review: not a git repository\n");
		});

		it("shows the risk on one line with its lenses and reasons", () => {
			const { stdout } = render([
				{
					type: "review_assessed",
					tree: "t",
					level: "high",
					reasons: ["path: src/auth.ts (auth)", "dependencies: package.json"],
					files: ["src/auth.ts"],
					changedLines: 9,
					lenses: ["risk", "resilience", "readability", "reliability"],
					reviewDue: true,
				},
				{
					type: "review_assessed",
					tree: "t",
					level: "medium",
					reasons: [],
					files: ["a.ts"],
					changedLines: 1,
					lenses: ["reliability"],
					reviewDue: false,
				},
			]);
			expect(stdout).toBe(
				"◇ review high · 4 lenses (path: src/auth.ts (auth); dependencies: package.json)\n◇ review medium · 1 lens\n",
			);
		});

		it("names the lenses the agent chose and why, and only then", () => {
			const { stdout } = render([
				{
					type: "review_assessed",
					tree: "t",
					level: "high",
					reasons: ["agent: item 4 (events can arrive late)"],
					files: ["a.ts"],
					changedLines: 1,
					lenses: ["resilience", "reliability"],
					lensesReason: "only the event order changes",
					reviewDue: true,
				},
			]);
			expect(stdout).toBe(
				"◇ review high · 2 lenses: resilience, reliability (agent: item 4 (events can arrive late)) · lenses chosen: only the event order changes\n",
			);
		});

		it("shows the content-derived reasons with their place", () => {
			const { stdout } = render([
				{
					type: "review_assessed",
					tree: "t",
					level: "high",
					reasons: [
						"shell_process: src/run.ts:2",
						"dangerous_sink: src/run.ts:5 (eval)",
						"process_scan_limit: src/big.ts",
					],
					files: ["src/run.ts"],
					changedLines: 9,
					lenses: ["risk", "resilience", "readability", "reliability"],
					reviewDue: true,
				},
			]);
			expect(stdout).toBe(
				"◇ review high · 4 lenses (shell_process: src/run.ts:2; dangerous_sink: src/run.ts:5 (eval); process_scan_limit: src/big.ts)\n",
			);
		});

		it("says on the risk line that the session's reviews were allowed", () => {
			const { stdout } = render([
				{
					type: "review_assessed",
					tree: "t",
					level: "high",
					reasons: ["path: src/auth.ts (auth)"],
					files: ["src/auth.ts"],
					changedLines: 1,
					lenses: ["risk"],
					reviewDue: true,
					consent: "session",
				},
			]);
			expect(stdout).toBe("◇ review high · 1 lens (path: src/auth.ts (auth)) · allowed for this session\n");
		});

		it("shows a declared none on the risk line, and a missing declaration through its reason", () => {
			const base = { type: "review_assessed" as const, tree: "t", files: ["a.ts"], changedLines: 1, reviewDue: false };
			const { stdout } = render([
				{
					...base,
					level: "medium",
					reasons: ["code change without a high-risk signal"],
					lenses: ["reliability"],
					declaration: { kind: "none", reason: "no shared code" },
				},
				{
					...base,
					level: "medium",
					reasons: ["code change; no risk declaration"],
					lenses: ["reliability"],
					declaration: { kind: "missing" },
				},
			]);
			expect(stdout).toBe(
				"◇ review medium · 1 lens (code change without a high-risk signal) · declared none: no shared code\n◇ review medium · 1 lens (code change; no risk declaration)\n",
			);
		});

		it("says which commit the change is measured from, and why when the base fell back to HEAD", () => {
			const base = {
				type: "review_assessed" as const,
				tree: "t",
				level: "medium" as const,
				reasons: [],
				files: ["a.ts"],
				changedLines: 1,
				lenses: ["reliability"],
				reviewDue: false,
			};
			const { stdout } = render([
				{ ...base, since: "1a2b3c4" },
				{
					...base,
					baseNote: "HEAD no longer descends from 1a2b3c4, where the turn started: the base is the current HEAD",
				},
			]);
			expect(stdout).toBe(
				"◇ review medium · 1 lens · since 1a2b3c4\n◇ review medium · 1 lens · HEAD no longer descends from 1a2b3c4, where the turn started: the base is the current HEAD\n",
			);
		});

		it("leaves the consent question to the prompt", () => {
			const { stdout, stderr } = render([
				{ type: "review_consent_requested", reviewId: "r1", level: "high", reasons: ["x"], lenses: ["risk"] },
			]);
			expect([stdout, stderr]).toEqual(["", ""]);
		});

		it("shows one line per step of the cycle", () => {
			const { stdout } = render([
				{ type: "review_progress", reviewId: "r1", step: { type: "lens_started", lens: "risk" } },
				{
					type: "review_progress",
					reviewId: "r1",
					step: { type: "lens_finished", lens: "risk", ok: true, findings: 2 },
				},
				{
					type: "review_progress",
					reviewId: "r1",
					step: { type: "lens_finished", lens: "risk", ok: false, findings: 0 },
				},
				{ type: "review_progress", reviewId: "r1", step: { type: "refuter_started", findings: 1 } },
				{ type: "review_progress", reviewId: "r1", step: { type: "refuter_finished", confirmed: 1, refuted: 0 } },
				{
					type: "review_progress",
					reviewId: "r1",
					step: { type: "refuter_finished", confirmed: 0, refuted: 1, downgraded: 2 },
				},
				{ type: "review_progress", reviewId: "r1", step: { type: "correction_started", budget: 12, findings: 1 } },
				{ type: "review_progress", reviewId: "r1", step: { type: "correction_finished", ok: true, used: 8 } },
				{ type: "review_progress", reviewId: "r1", step: { type: "correction_finished", ok: false } },
				{ type: "review_progress", reviewId: "r1", step: { type: "validator_started", findings: 1 } },
				{ type: "review_progress", reviewId: "r1", step: { type: "validator_finished", resolved: 1, unresolved: 0 } },
			]);
			expect(stdout).toBe(
				[
					"◇ review: lens risk",
					"◇ review: lens risk done · 2 findings",
					"◇ review: lens risk failed",
					"◇ review: refuting 1 finding",
					"◇ review: 1 confirmed · 0 refuted",
					"◇ review: 0 confirmed · 1 refuted · 2 downgraded",
					"◇ review: correcting (budget 12 lines)",
					"◇ review: correction done · 8 lines",
					"◇ review: correction failed",
					"◇ review: validating 1 finding",
					"◇ review: 1 resolved · 0 unresolved",
					"",
				].join("\n"),
			);
		});

		it("nests the lens's own work like a subagent", () => {
			const { stdout } = render([
				{
					type: "session_started",
					backend: "fake",
					model: "m",
					authSource: "subscription",
					parentCallId: "r1",
					agent: "review:risk",
				},
				{ type: "text_delta", text: "looking", parentCallId: "r1", agent: "review:risk" },
			] as never);
			expect(stdout).toBe("  ↳ review:risk · m\n  │ looking");
		});

		it("says approved with the receipt, relative to the working directory", () => {
			const { stdout } = render([{ ...finished, receiptPath: "/repo/.git/atelier/reviews/abc.json" }], "/repo");
			expect(stdout).toBe("✓ review approved · receipt .git/atelier/reviews/abc.json\n");
		});

		it("keeps an absolute receipt path that is outside the working directory", () => {
			const { stdout } = render([{ ...finished, receiptPath: "/elsewhere/r.json" }], "/repo");
			expect(stdout).toBe("✓ review approved · receipt /elsewhere/r.json\n");
		});

		it("counts the correction and the follow-ups of an approved review", () => {
			const { stdout } = render([
				{ ...finished, correction: { budget: 12, used: 8 }, followUps: [finding, finding], receiptPath: "r.json" },
			]);
			expect(stdout).toBe("✓ review approved · corrected 8/12 lines · 2 follow-ups · receipt r.json\n");
		});

		it("says plainly that an over-budget correction stays in the worktree", () => {
			const { stdout } = render([
				{
					...finished,
					verdict: "escalated",
					reason: "The correction changed 30 lines, over the budget of 12.",
					findings: [finding],
					correction: { budget: 12, used: 30 },
					receiptPath: "r.json",
				},
			]);
			expect(stdout).toBe(
				[
					"✗ review escalated: The correction changed 30 lines, over the budget of 12. — the correction is left in your worktree, review it before committing",
					"  RL-001 critical src/auth.ts:12 — The token is dropped.",
					"  receipt r.json",
					"",
				].join("\n"),
			);
		});

		it("does not claim a correction when none was applied", () => {
			const { stdout } = render([
				{ ...finished, verdict: "escalated", reason: "Unresolved.", findings: [finding], correction: null },
			]);
			expect(stdout).not.toContain("left in your worktree");
			expect(stdout).toContain("✗ review escalated: Unresolved.\n");
		});

		it("says declined and unavailable", () => {
			const { stdout } = render([
				{ ...finished, verdict: "declined" },
				{ ...finished, verdict: "unavailable", reason: "lens_context_budget_exceeded" },
			]);
			expect(stdout).toBe("◇ review declined\n◇ review unavailable: lens_context_budget_exceeded\n");
		});

		it("shows the cause and the value observed instead of the reason", () => {
			const { stdout } = render([
				{
					...finished,
					verdict: "unavailable",
					reason: "lens_context_budget_exceeded",
					cause: "context_too_large",
					observed: "215000 bytes, limit 204800",
				},
				{
					...finished,
					verdict: "escalated",
					reason: "The correction changed 30 lines, over the budget of 12.",
					cause: "over_budget",
					observed: "30 lines, budget 12",
				},
			]);
			expect(stdout).toBe(
				[
					"◇ review unavailable: context_too_large (215000 bytes, limit 204800)",
					"✗ review escalated: over_budget (30 lines, budget 12)",
					"",
				].join("\n"),
			);
		});
	});

	describe("compaction", () => {
		const started: AtelierEventBody = { type: "compaction_started", reason: "threshold", tokens: 180_000 };
		const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

		it("shows the compaction, how much the context went down, what was kept and its cost", () => {
			const { stdout, stderr } = render([
				started,
				{
					type: "compaction_finished",
					ok: true,
					reason: "threshold",
					tokensBefore: 180_000,
					tokensAfter: 30_000,
					kept: 3,
					usage: zero,
					costUsd: 0.012,
				},
			]);
			expect(stdout).toBe(
				"◇ compacting context (threshold, 180,000 tokens)\n◇ context compacted: 180,000 → 30,000 tokens · 3 messages kept · $0.0120\n",
			);
			expect(stderr).toBe("");
		});

		it("leaves out what Claude Code does not report", () => {
			const { stdout } = render([
				{ type: "compaction_finished", ok: true, reason: "manual", tokensBefore: 90_000, kept: 0, usage: zero },
			]);
			expect(stdout).toBe("◇ context compacted: 90,000 tokens before\n");
		});

		it("warns when a compaction fails", () => {
			const { stdout, stderr } = render([
				{
					type: "compaction_finished",
					ok: false,
					reason: "manual",
					tokensBefore: 900,
					kept: 0,
					usage: zero,
					error: "There is not enough history to compact.",
				},
			]);
			expect(stdout).toBe("");
			expect(stderr).toBe("compaction failed: There is not enough history to compact.\n");
		});

		it("shows the first cache miss after a compaction as expected, and later ones as warnings", () => {
			const miss: AtelierEventBody = { type: "cache_miss", reason: "messages_changed", missedTokens: 5000 };
			const { stdout, stderr } = render([
				{ type: "compaction_finished", ok: true, reason: "threshold", tokensBefore: 9000, kept: 1, usage: zero },
				miss,
				miss,
			]);
			expect(stdout).toContain("cache miss after compaction: messages_changed (expected)\n");
			expect(stderr).toBe("cache miss: messages_changed (5,000 tokens not read from the cache)\n");
		});

		it("expects the miss only in the compaction's turn and the next one", () => {
			const miss: AtelierEventBody = { type: "cache_miss", reason: "messages_changed", missedTokens: 5000 };
			const turn: AtelierEventBody = { type: "turn_finished", stopReason: "end_turn", usage };
			const compacted: AtelierEventBody = {
				type: "compaction_finished",
				ok: true,
				reason: "manual",
				tokensBefore: 9000,
				kept: 1,
				usage: zero,
			};
			expect(render([compacted, turn, miss]).stderr).toBe("");
			expect(render([compacted, turn, turn, miss]).stderr).toBe(
				"cache miss: messages_changed (5,000 tokens not read from the cache)\n",
			);
		});

		it("shows a subagent's compaction under the subagent, with its own expected miss", () => {
			const child = { parentCallId: "c1", agent: "worker" };
			const miss: AtelierEventBody = { type: "cache_miss", reason: "messages_changed", missedTokens: 5000 };
			const { stdout, stderr } = render([
				{ ...started, ...child },
				{
					type: "compaction_finished",
					ok: true,
					reason: "threshold",
					tokensBefore: 180_000,
					tokensAfter: 30_000,
					kept: 2,
					usage: zero,
					...child,
				},
				{ ...miss, ...child },
				{ ...miss, ...child },
				{
					type: "compaction_finished",
					ok: false,
					reason: "overflow",
					tokensBefore: 900,
					kept: 0,
					usage: zero,
					error: "The summary was cut short.",
					...child,
				},
				// The child's compaction does not change what the parent's context expects.
				miss,
			]);
			expect(stdout).toBe(
				[
					"  │ ◇ compacting context (threshold, 180,000 tokens)",
					"  │ ◇ context compacted: 180,000 → 30,000 tokens · 2 messages kept",
					"  │ cache miss after compaction: messages_changed (expected)",
					"",
				].join("\n"),
			);
			expect(stderr).toBe(
				[
					"  │ cache miss: messages_changed (5,000 tokens not read from the cache)",
					"  │ compaction failed: The summary was cut short.",
					"cache miss: messages_changed (5,000 tokens not read from the cache)",
					"",
				].join("\n"),
			);
		});

		it("adds how full the context is to the tokens line", () => {
			const { stdout } = render([
				{
					type: "turn_finished",
					stopReason: "end_turn",
					usage,
					context: { tokens: 45_000, window: 200_000, compactAt: 167_616 },
				},
			]);
			expect(stdout).toContain(" · context 45,000 / 200,000 (23%)\n");
		});

		it("says the context size is unknown right after a compaction", () => {
			const { stdout } = render([
				{
					type: "turn_finished",
					stopReason: "end_turn",
					usage,
					context: { tokens: 3000, window: 1_000_000, compactAt: 967_000, unknown: true },
				},
			]);
			expect(stdout).toContain(" · context ? / 1,000,000\n");
		});
	});

	describe("verification", () => {
		const defect = (over: Record<string, unknown> = {}) => ({
			id: "D1",
			severity: "blocker" as const,
			summary: "A pasted y approves the command",
			reproduction: "printf 'ls\\ny' | node cli.ts",
			candidate: "ran ls",
			base: "asked again",
			onBase: false,
			...over,
		});
		const requirement = (verdict: "met" | "unmet" | "unverified", id = "R1") => ({
			id,
			requirement: "approval needs a keypress",
			verdict,
			evidence: "ran it",
		});
		const round = (over: Record<string, unknown> = {}): AtelierEventBody =>
			({
				type: "verification_round",
				verifyId: "v1",
				round: 1,
				ok: true,
				requirements: [],
				defects: [],
				blocking: [],
				correcting: false,
				usage,
				...over,
			}) as AtelierEventBody;
		const done = (over: Record<string, unknown> = {}): AtelierEventBody =>
			({
				type: "verification_finished",
				verifyId: "v1",
				outcome: "passed",
				rounds: 1,
				openDefects: [],
				usage,
				...over,
			}) as AtelierEventBody;

		it("says what is being verified", () => {
			const { stdout } = render([
				{ type: "verification_started", verifyId: "v1", items: [2, 5], declaration: [{ items: [2, 5], reason: "x" }] },
			]);
			expect(stdout).toBe("◇ verifying · items 2, 5\n");
		});

		it("shows a round with its defects and severities, and that they go to the agent", () => {
			const { stdout } = render([
				round({
					defects: [defect(), defect({ id: "D2", severity: "major" })],
					blocking: ["D1", "D2"],
					correcting: true,
				}),
			]);
			expect(stdout).toBe("◇ verify · round 1 · 2 defects (blocker, major) · asking the agent to fix them\n");
		});

		it("counts the requirements, the defects that are also on the base, and a round without defects", () => {
			const { stdout } = render([
				round({ requirements: [requirement("met"), requirement("unmet", "R2"), requirement("unverified", "R3")] }),
				round({ round: 2, defects: [defect({ onBase: true }), defect({ id: "D2", severity: "minor" })] }),
			]);
			expect(stdout).toBe(
				[
					"◇ verify · round 1 · no defects · 1 met, 1 unmet, 1 unverified",
					"◇ verify · round 2 · 2 defects (blocker, minor), 1 also on the base",
					"",
				].join("\n"),
			);
		});

		it("says a verifier that failed did not pass", () => {
			const { stdout } = render([round({ ok: false, error: "The verifier returned an invalid report: no JSON" })]);
			expect(stdout).toBe("◇ verify · round 1 · failed: The verifier returned an invalid report: no JSON\n");
		});

		it("ends passed, passed after a correction, or failed", () => {
			const { stdout } = render([
				done(),
				done({ outcome: "corrected", rounds: 2, costUsd: 0.0421 }),
				done({ outcome: "failed", reason: "model down" }),
			]);
			expect(stdout).toBe(
				[
					"✓ verify passed",
					"✓ verify passed after a correction · 2 rounds · $0.0421",
					"✗ verify failed: model down · needs your decision",
					"",
				].join("\n"),
			);
		});

		it("says what could not be verified when nothing else is open", () => {
			const { stdout } = render([
				done({
					outcome: "needs_decision",
					reason: "1 unverified requirement: R1 the approval needs a keypress (could not run it)",
				}),
			]);
			expect(stdout).toBe(
				"✗ verify: needs your decision · 1 unverified requirement: R1 the approval needs a keypress (could not run it)\n",
			);
		});

		it("lists the open defects when the user must decide", () => {
			const { stdout } = render([
				done({ outcome: "needs_decision", rounds: 2, openDefects: [defect({ id: "D2", severity: "major" })] }),
				done({
					outcome: "needs_decision",
					reason: "The correction failed.",
					openDefects: [defect(), defect({ id: "D2" })],
				}),
			]);
			expect(stdout).toBe(
				[
					"✗ verify: needs your decision · 1 open defect",
					"  D2 major — A pasted y approves the command",
					"    reproduce: printf 'ls\\ny' | node cli.ts",
					"✗ verify: needs your decision · 2 open defects · The correction failed.",
					"  D1 blocker — A pasted y approves the command",
					"    reproduce: printf 'ls\\ny' | node cli.ts",
					"  D2 blocker — A pasted y approves the command",
					"    reproduce: printf 'ls\\ny' | node cli.ts",
					"",
				].join("\n"),
			);
		});

		it("shows the cause and the value observed instead of the message", () => {
			const { stdout } = render([
				round({
					ok: false,
					error: "The verifier returned an invalid report: no JSON",
					cause: "invalid_report",
					observed: "looks fine to me",
				}),
				done({ outcome: "failed", reason: "turn_limit: ...", cause: "request_cap", observed: "80 requests" }),
				done({ outcome: "failed", reason: "interrupted", cause: "interrupted" }),
				done({
					outcome: "needs_decision",
					reason: "1 unverified requirement: R1 the approval needs a keypress (bash was not available)",
					cause: "sandbox_unavailable",
					observed: "sandbox not available on this platform",
				}),
				done({
					outcome: "needs_decision",
					rounds: 2,
					openDefects: [defect({ id: "D2", severity: "major" })],
					cause: "open_defects",
					observed: "D2",
				}),
			]);
			expect(stdout).toBe(
				[
					"◇ verify · round 1 · failed: invalid_report (looks fine to me)",
					"✗ verify failed: request_cap (80 requests) · needs your decision",
					"✗ verify failed: interrupted · needs your decision",
					"✗ verify: needs your decision · sandbox_unavailable (sandbox not available on this platform) · 1 unverified requirement: R1 the approval needs a keypress (bash was not available)",
					"✗ verify: needs your decision · open_defects (D2)",
					"  D2 major — A pasted y approves the command",
					"    reproduce: printf 'ls\\ny' | node cli.ts",
					"",
				].join("\n"),
			);
		});

		it("nests the verifier's own work like a subagent", () => {
			const { stdout } = render([
				{ type: "text_delta", text: "probing", parentCallId: "v1", agent: "verify:verifier" },
			] as never);
			expect(stdout).toBe("  │ probing");
		});
	});

	it("says which files an undone correction put back and removed", () => {
		const { stdout } = render([
			{ type: "correction_undone", reviewId: "r1", restored: ["a.ts", "src/auth.ts"], removed: ["src/extra.ts"] },
			{ type: "correction_undone", reviewId: "r2", restored: ["a.ts"], removed: [] },
		]);
		expect(stdout).toBe(
			"✓ correction undone · restored a.ts, src/auth.ts · removed src/extra.ts\n✓ correction undone · restored a.ts\n",
		);
	});
});
