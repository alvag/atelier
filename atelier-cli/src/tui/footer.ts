import { basename } from "node:path";
import {
	type AtelierEvent,
	type ContextUsage,
	type Phase,
	type SessionConfiguration,
	visibleText,
} from "@atelier/core";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type FeatureProgress, featureProgress } from "./feature-panel.ts";
import type { Paint } from "./style.ts";

/** What the fixed footer says about the session: filled in by its events, unknown until one says it. */
export interface FooterState {
	backend?: string;
	model?: string;
	effort?: string;
	profile?: string;
	mode?: string;
	/** Whether `bash` runs in the sandbox. */
	sandboxed?: boolean;
	context?: ContextUsage;
	/** What the session's turns cost so far; absent while no turn reported a cost. */
	costUsd?: number;
	phase?: Phase;
	/** The active feature's task in progress and how many of its tasks are done. */
	task?: FeatureProgress;
	/** The working directory, shown by its folder's name. */
	cwd?: string;
	/** The git branch of the working directory, or the short commit of a detached HEAD. */
	branch?: string;
	/** Atelier's version. */
	version?: string;
}

/** The items the status line can show, as `statusLine` in `~/.atelier/settings.json` names them. */
export const STATUS_ITEMS = [
	"model",
	"effort",
	"backend",
	"cwd",
	"git-branch",
	"profile",
	"mode",
	"sandbox",
	"context",
	"cost",
	"phase",
	"task",
	"version",
] as const;
export type StatusItem = (typeof STATUS_ITEMS)[number];

export const isStatusItem = (value: unknown): value is StatusItem => STATUS_ITEMS.some((item) => item === value);

/** What the footer always showed, with the working folder and the branch after the model. */
export const DEFAULT_STATUS_LINE: StatusItem[] = [
	"model",
	"effort",
	"cwd",
	"git-branch",
	"profile",
	"mode",
	"sandbox",
	"context",
	"cost",
	"phase",
	"task",
];

/** The footer after one of the main agent's events; a subagent's events say nothing about the session. */
export function footerAfter(state: FooterState, event: AtelierEvent): FooterState {
	if (event.parentCallId !== undefined) return state;
	switch (event.type) {
		case "session_started":
			return {
				...state,
				backend: event.backend,
				model: event.model,
				...(event.effort === undefined ? {} : { effort: event.effort }),
				...(event.profile === undefined ? {} : { profile: event.profile.name ?? event.profile.origin }),
				...(event.permissionMode === undefined ? {} : { mode: event.permissionMode }),
			};
		case "session_configured":
			return footerWithConfiguration(state, event);
		case "sandbox_status":
			return { ...state, sandboxed: event.sandboxed };
		case "sandbox_warning":
			return { ...state, sandboxed: false };
		case "turn_finished":
			return {
				...state,
				...(event.context === undefined ? {} : { context: event.context }),
				...(event.costUsd === undefined ? {} : { costUsd: (state.costUsd ?? 0) + event.costUsd }),
			};
		case "phase_changed":
			return { ...state, phase: event.phase };
		// The same progress as the feature panel's.
		case "feature_changed":
			return { ...state, task: featureProgress(event) };
		default:
			return state;
	}
}

/**
 * The footer after the configuration a command answered or `session_configured` said: an absent model or level is the
 * backend's default, so the one shown before goes.
 */
export function footerWithConfiguration(
	state: FooterState,
	configuration: Omit<SessionConfiguration, "pending" | "thinking"> & { thinking?: string },
): FooterState {
	const { model: _model, effort: _effort, ...rest } = state;
	return {
		...rest,
		backend: configuration.backend,
		...(configuration.model === undefined ? {} : { model: configuration.model }),
		...(configuration.thinking === undefined ? {} : { effort: configuration.thinking }),
		...(configuration.profile === undefined
			? {}
			: { profile: configuration.profile.name ?? configuration.profile.origin }),
		mode: configuration.permissionMode,
	};
}

/** Sets the mode a client changed, which the session reports only in its next turn. */
export const footerWithMode = (state: FooterState, mode: string): FooterState => ({ ...state, mode });

/** One item of the status line, or nothing while the session has not said it. */
function itemText(item: StatusItem, state: FooterState, paint: Paint): string | undefined {
	switch (item) {
		// Without a model, the backend's default runs: the backend says which.
		case "model": {
			const model = state.model ?? state.backend;
			return model === undefined ? undefined : paint("bold", shown(model));
		}
		case "effort":
			return state.effort === undefined ? undefined : paint("bold", shown(state.effort));
		case "backend":
			return state.backend === undefined ? undefined : shown(state.backend);
		case "cwd":
			return state.cwd === undefined ? undefined : shown(basename(state.cwd) || state.cwd);
		case "git-branch":
			return state.branch === undefined ? undefined : paint("cyan", shown(state.branch));
		case "profile":
			return state.profile === undefined ? undefined : `profile ${shown(state.profile)}`;
		case "mode":
			if (state.mode === undefined) return undefined;
			return state.mode === "normal" ? state.mode : paint("yellow", shown(state.mode));
		case "sandbox":
			if (state.sandboxed === undefined) return undefined;
			return state.sandboxed ? "sandbox ✓" : paint("yellow", "sandbox ✗");
		case "context":
			return state.context === undefined ? undefined : `ctx ${contextShare(state.context)}%`;
		case "cost":
			return state.costUsd === undefined ? undefined : `$${state.costUsd.toFixed(2)}`;
		case "phase":
			return state.phase === undefined ? undefined : paint("magenta", shown(state.phase));
		case "task": {
			if (state.task === undefined) return undefined;
			const { id, done, total } = state.task;
			return id === undefined ? `${done}/${total}` : `${shown(id)} ${done}/${total}`;
		}
		case "version":
			return state.version === undefined ? undefined : `v${shown(state.version)}`;
	}
}

/**
 * `claude-opus-5-5 high · atelier · main · profile claude · auto · sandbox ✓ · ctx 34% · $0.42 · implementing · T2 2/5`:
 * the items chosen in their order, the ones not known yet left out, cut to the width. The effort right after the model
 * goes with it, as one part.
 */
export function footerLine(
	state: FooterState,
	width: number,
	paint: Paint,
	items: readonly StatusItem[] = DEFAULT_STATUS_LINE,
): string {
	const parts: string[] = [];
	let previous: StatusItem | undefined;
	for (const item of items) {
		const text = itemText(item, state, paint);
		if (text === undefined) continue;
		if (item === "effort" && previous === "model" && parts.length > 0) parts.push(`${parts.pop()} ${text}`);
		else parts.push(text);
		previous = item;
	}
	return truncateToWidth(` ${parts.join(paint("dim", " · "))}`, width);
}

/** Event strings shown with markers for control characters, as the line CLI shows them. */
const shown = (text: string) => visibleText(text).text;

const contextShare = ({ tokens, window }: ContextUsage) => (window > 0 ? Math.round((tokens / window) * 100) : 0);
