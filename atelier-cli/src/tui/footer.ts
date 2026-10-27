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
}

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

/**
 * `claude-opus-5-5 high · profile claude · auto · sandbox ✓ · ctx 34% · $0.42 · implementing · T2 2/5`, the parts not
 * known yet left out, cut to the width.
 */
export function footerLine(state: FooterState, width: number, paint: Paint): string {
	const parts: string[] = [];
	const model = [state.model ?? state.backend, state.effort]
		.filter((part) => part !== undefined)
		.map(shown)
		.join(" ");
	if (model !== "") parts.push(paint("bold", model));
	if (state.profile !== undefined) parts.push(`profile ${shown(state.profile)}`);
	if (state.mode !== undefined) parts.push(state.mode === "normal" ? state.mode : paint("yellow", shown(state.mode)));
	if (state.sandboxed !== undefined) parts.push(state.sandboxed ? "sandbox ✓" : paint("yellow", "sandbox ✗"));
	if (state.context !== undefined) parts.push(`ctx ${contextShare(state.context)}%`);
	if (state.costUsd !== undefined) parts.push(`$${state.costUsd.toFixed(2)}`);
	if (state.phase !== undefined) parts.push(paint("magenta", shown(state.phase)));
	if (state.task !== undefined) {
		const { id, done, total } = state.task;
		parts.push(id === undefined ? `${done}/${total}` : `${shown(id)} ${done}/${total}`);
	}
	return truncateToWidth(` ${parts.join(paint("dim", " · "))}`, width);
}

/** Event strings shown with markers for control characters, as the line CLI shows them. */
const shown = (text: string) => visibleText(text).text;

const contextShare = ({ tokens, window }: ContextUsage) => (window > 0 ? Math.round((tokens / window) * 100) : 0);
