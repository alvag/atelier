import type { AtelierEvent, AtelierEventBody, JsonValue, QueueKind } from "../events.ts";
import type { ImageAttachment } from "../images.ts";
import type { PermissionRuleScope } from "../permission-rules.ts";
import type { ReviewConsentAnswer } from "../review/session-review.ts";
import type { PermissionMode } from "../session.ts";
import type { ThinkingLevel } from "../thinking.ts";
import type { UserAnswer, UserQuestionCapabilities } from "../tools/ask-user.ts";

/** Bumped on any incompatible change; sent first by the server in `hello`. */
export const PROTOCOL_VERSION = 7;

/** Limit of the instructions a client may give `session.compact`. */
export const MAX_COMPACT_INSTRUCTIONS_BYTES = 2000;

/** The longest name `session.rename` takes. */
export const MAX_SESSION_NAME_CHARS = 200;

/** What a saved session's id looks like: it names a file, so nothing that could leave the folder. */
export const isSavedSessionId = (value: string): boolean => /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

export const BACKEND_NAMES = ["claude-code", "anthropic-api", "opencode-go", "openai-codex"] as const;
/**
 * claude-code uses the Claude subscription; anthropic-api and opencode-go run Atelier's own loop on an API key;
 * openai-codex runs it on the ChatGPT subscription.
 */
export type BackendName = (typeof BACKEND_NAMES)[number];
export const DEFAULT_BACKEND: BackendName = "claude-code";

export type ClientCommand =
	/**
	 * Starts a session; answers `sessionId`, `savedId` when it is saved, and `configuration`, what the first turn runs
	 * with (as `session.set_model` answers it).
	 */
	| {
			command: "session.start";
			cwd: string;
			model?: string;
			/** Ignored: use `mode`. */
			autoApprove?: boolean;
			/** The permission mode of the session; without it, the default in `~/.atelier/permission-mode.json`, then `normal`. */
			mode?: PermissionMode;
			backend?: BackendName;
			review?: boolean;
			/** Runs `bash` without the sandbox (every command asks); the server's own ATELIER_SANDBOX=off applies to all sessions. */
			noSandbox?: boolean;
			/** The profile chosen for this session: the first layer of the resolution. */
			profile?: string;
			/** Does not save the session (the CLI's `--no-session`); without it the server saves it when it has a home directory. */
			noSession?: boolean;
			/**
			 * Opts in to `ask_user` questions (`user_question_requested`, answered by `session.answer_user`); without it the
			 * tool is unavailable at once. `{ multiSelect: true }` also lets the model ask multi-select questions, and
			 * `{ preview: true }` gives options a preview; `true` keeps them all single-choice, without previews.
			 */
			userQuestions?: boolean | UserQuestionCapabilities;
			/** Opts in to `session_event` messages, events outside any turn; without it they go first in the next turn. */
			sessionEvents?: boolean;
	  }
	/** The profiles in `~/.atelier/profiles.json`, its `active`, and with `cwd`, the profile a session there would take without a choice. */
	| { command: "profiles.list"; cwd?: string }
	| { command: "session.send"; sessionId: string; prompt: string; images?: ImageAttachment[] }
	| { command: "session.interrupt"; sessionId: string }
	/**
	 * Queues a message while a turn runs: a `steer` enters the running turn with its next tool result, a `follow_up`
	 * runs as a turn of its own after it (see `queue_update` and `queued_message`). Answers `{ id }`; when no turn runs,
	 * the message starts one at once and the answer adds its `turnId`. Fails with `turn_ended` while a turn that was interrupted
	 * or failed is ending: it gave its queue back, takes nothing more, and the client keeps the message.
	 */
	| { command: "session.queue"; sessionId: string; kind: QueueKind; text: string }
	/** Changes a queued message's text; fails with `not_queued` once it entered the conversation or left the queue. Answers `{}`. */
	| { command: "session.queue_edit"; sessionId: string; messageId: string; text: string }
	/** Takes the queued message `messageId` off the queue, or all of them without one; answers `{ messages }`, what it took. */
	| { command: "session.unqueue"; sessionId: string; messageId?: string }
	/**
	 * Answers an approval question. `remember` (with `approved: true`) also keeps the rules the question offered, for the
	 * session, always in the project or always; `project` and `always` are honored only when the question offered them.
	 */
	| {
			command: "session.approve";
			sessionId: string;
			callId: string;
			approved: boolean;
			remember?: PermissionRuleScope;
	  }
	/**
	 * The rules in force for the session, its own and the saved ones: answers `{ rules: [{ id, scope, kind, value,
	 * project?, ignored? }] }`; `project` names a project rule's project, `ignored` a saved rule no longer used.
	 */
	| { command: "session.permissions"; sessionId: string }
	/**
	 * Answers the `ask_user` batch `callId` of a session that opted in with `userQuestions`: one answer per question
	 * (`optionId` or `other`; `optionIds`, possibly empty, with an optional `other` for a multi-select one), or `null`
	 * to cancel. Answers `{}`. Fails with `invalid_answer` (the question stays
	 * pending) or `unknown_question` (answered, ended or never asked).
	 */
	| { command: "session.answer_user"; sessionId: string; callId: string; answers: UserAnswer[] | null }
	/** Removes the rule whose `id` `session.permissions` gave as `ruleId`; answers the rules left, or fails with `unknown_rule`. */
	| { command: "session.permissions_remove"; sessionId: string; ruleId: string }
	/** Reviews the current uncommitted change at any risk, against HEAD or the git ref `ref` names; answers like session.send. */
	| { command: "session.review"; sessionId: string; ref?: string }
	| { command: "session.review_consent"; sessionId: string; reviewId: string; answer: ReviewConsentAnswer }
	/** Undoes the correction an escalated review left in the worktree (that review of the session, or the repository's latest escalated one); answers like session.send. */
	| { command: "session.undo_correction"; sessionId: string; reviewId?: string }
	/** Summarizes the older history now; answers like session.send. `instructions`: at most 2000 bytes. */
	| { command: "session.compact"; sessionId: string; instructions?: string }
	/** Changes the session's permission mode for its next tool calls; answers `{ mode }`. */
	| { command: "session.set_mode"; sessionId: string; mode: PermissionMode }
	/**
	 * Changes the model of the main agent for the next turn; answers the session's configuration (`backend`, `model`,
	 * `thinking`, `effort` as the backend sends the level, `permissionMode`, `profile`) and `pending`, true while a
	 * running turn holds the change until it ends.
	 */
	| { command: "session.set_model"; sessionId: string; model: string }
	/** Changes the thinking level of the main agent (`effort`, in the profiles' level names) like `session.set_model`. */
	| { command: "session.set_effort"; sessionId: string; effort: ThinkingLevel }
	/**
	 * Re-resolves and freezes the profile `profile` for the session; the verifier, lenses, subagents, classifier and
	 * compaction use it from the next turn, and the main agent takes the orchestrator's entry unless the model or the
	 * level was chosen explicitly. Held while a turn runs, like `session.set_model`, and answers the same configuration.
	 * Fails with `unknown_profile` (nothing named so), `invalid_profile_name` (the name is not one a profile may
	 * carry), `profile_unavailable` (the server reads no profiles) or
	 * `profile_backend_change` (the orchestrator's entry names another backend than the session's); nothing changes then.
	 */
	| { command: "session.set_profile"; sessionId: string; profile: string }
	/**
	 * Moves the session to another backend from the next turn: the conversation is summarized (as a compaction does),
	 * the new backend starts with `model` (absent: the profile's orchestrator entry, then the backend's default) and
	 * gets the summary with its first prompt, the old backend is closed and the summary is saved to memory as a
	 * compaction summary is. Detail and the prompt cache are lost. Held while a turn runs, like `session.set_model`.
	 * Answers the session's configuration plus `backendChange` (`from`, `summarized`: true when a summary carried the
	 * history). Fails with `summary_failed`, `summary_unsupported` (the current backend cannot summarize), `same_backend`,
	 * `backend_start_failed`, `missing_api_key` or `keychain_error` (the server cannot create the backend); the session
	 * keeps its old backend untouched then. An unknown backend name is `invalid_command`.
	 */
	| { command: "session.set_backend"; sessionId: string; backend: BackendName; model?: string }
	/**
	 * What a client can offer: `backends` (`name`, `models`), `efforts`, `modes`, and what `profiles.list` answers
	 * (`profiles`, `active`, and with `cwd`, `effective`).
	 */
	| { command: "options.list"; cwd?: string }
	/**
	 * The sessions saved for the folder `cwd`, newest first (by the last write): `id`, `name`, `createdAt`, `updatedAt`,
	 * `turns`, `lastPrompt` (one line, at most 80 characters), `backend`, `model` and `resumable`; a file that cannot be
	 * resumed (a newer format, corruption) is listed with `resumable: false` and its `problem`. Answers `{ sessions }`.
	 */
	| { command: "sessions.list"; cwd: string }
	/**
	 * Starts a session from the saved session `sessionId` of the folder `cwd`: its backend, model, thinking level and mode
	 * come back, the profile is frozen again by name as at start, and the backend resumes (Claude Code with its session
	 * id, anthropic-api with the saved history). Answers like `session.start` (`sessionId`, `savedId`) plus `name`,
	 * `createdAt`, `configuration` and `entries`: the saved transcript to show again, in order. Fails with `not_found`,
	 * `unsupported_version`, `corrupt`, `session_in_use` (this server already runs it) or `session_resume_failed`
	 * (the backend could not resume, as when Claude Code lost the session); nothing is started then.
	 */
	| {
			command: "session.resume";
			sessionId: string;
			cwd: string;
			userQuestions?: boolean | UserQuestionCapabilities;
			sessionEvents?: boolean;
	  }
	/** Names a saved session of the folder `cwd` (1 to 200 characters); appended to its file, never rewriting it. Answers `{}`. */
	| { command: "session.rename"; sessionId: string; cwd: string; name: string }
	/** Deletes a saved session's file; refused with `session_in_use` while this server runs it. Answers `{}`. */
	| { command: "session.delete"; sessionId: string; cwd: string }
	| { command: "session.close"; sessionId: string }
	/** The session's MCP servers now: answers `{ servers, problems }` as `mcp_status` carries them; both empty without MCP. */
	| { command: "session.mcp"; sessionId: string }
	/**
	 * Signs an HTTP server of the session in with OAuth: the core opens the authorization page in the browser and waits
	 * for it, up to five minutes, then connects the server again. Answers `{ servers, problems }` as `session.mcp`.
	 */
	| { command: "session.mcp_login"; sessionId: string; server: string }
	/** Deletes a server's OAuth credentials and connects it again. Answers `{ servers, problems }` as `session.mcp`. */
	| { command: "session.mcp_logout"; sessionId: string; server: string }
	| { command: "shutdown" };

export type CommandName = ClientCommand["command"];

/** Every command carries an id and gets exactly one response with that id. */
export type ClientMessage = { type: "command"; id: string } & ClientCommand;

export interface ProtocolError {
	code: string;
	message: string;
}

export type ServerMessage =
	| { type: "hello"; protocol: number; core: string }
	| { type: "response"; id: string; ok: true; result: { [key: string]: JsonValue } }
	| { type: "response"; id: string; ok: false; error: ProtocolError }
	| { type: "event"; sessionId: string; event: AtelierEvent }
	/**
	 * An event outside any turn, which starts none: the end of a background job after a turn that was interrupted or
	 * failed (`job_finished`, its notice waiting for the next prompt). No `seq` or `turnId`. Sent only to a session
	 * whose `session.start` or `session.resume` asked for it with `sessionEvents`; other clients get the event first in
	 * the next turn, as before.
	 */
	| { type: "session_event"; sessionId: string; event: AtelierEventBody }
	/** A line the server could not attribute to any command. */
	| { type: "protocol_error"; message: string };
