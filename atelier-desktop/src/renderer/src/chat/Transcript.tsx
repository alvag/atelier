import { cacheHitRate } from "@atelier/core/protocol";
import { visibleText } from "@atelier/core/text";
import { memo } from "react";
import { renderMarkdown } from "./markdown.ts";
import type { Subagent, Turn, TurnItem } from "./reducer.ts";

const numbers = new Intl.NumberFormat("en-US");

function ToolRow({ item }: { item: Extract<TurnItem, { kind: "tool" }> }) {
	const mark = { running: "…", ok: "✓", error: "✗", denied: "⊘" }[item.status];
	return (
		<div className={`tool tool-${item.status}`} data-testid="tool-row">
			<span className="tool-mark">{mark}</span>
			<span className="tool-name">{item.tool}</span>
			<span className="tool-summary">{item.summary ?? JSON.stringify(item.input)}</span>
			{item.truncated ? <span className="tool-note">truncated</span> : null}
		</div>
	);
}

function ApprovalCard({
	item,
	onAnswer,
}: {
	item: Extract<TurnItem, { kind: "approval" }>;
	onAnswer: (callId: string, approved: boolean) => void;
}) {
	const command = visibleText(item.command);
	return (
		<fieldset className="approval">
			<legend>Run this command?</legend>
			{command.hadHidden ? (
				<div className="warning">
					This command contains invisible or control characters, shown below as markers. Check it carefully.
				</div>
			) : null}
			<pre>{command.text}</pre>
			{item.state === "pending" ? (
				<div className="approval-actions">
					<button type="button" onClick={() => onAnswer(item.callId, true)}>
						Allow
					</button>
					<button type="button" onClick={() => onAnswer(item.callId, false)}>
						Deny
					</button>
				</div>
			) : (
				<div className="approval-state">{item.state === "approved" ? "Allowed" : "Denied"}</div>
			)}
		</fieldset>
	);
}

function TokenLine({ finished }: { finished: NonNullable<Turn["finished"]> }) {
	const { input, output, cacheRead, cacheWrite } = finished.usage;
	const parts = [
		`input ${numbers.format(input)}`,
		`output ${numbers.format(output)}`,
		`cache read ${numbers.format(cacheRead)}`,
		`cache write ${numbers.format(cacheWrite)}`,
	];
	const rate = cacheHitRate(finished.usage);
	if (rate !== undefined) parts.push(`cache ${Math.round(rate * 100)}%`);
	if (finished.requests !== undefined) parts.push(`${finished.requests} request${finished.requests === 1 ? "" : "s"}`);
	if (finished.costUsd !== undefined) parts.push(`$${finished.costUsd.toFixed(4)}`);
	return <div className="tokens">tokens: {parts.join(" · ")}</div>;
}

type OnAnswer = (callId: string, approved: boolean) => void;

function Items({ items, onAnswer }: { items: TurnItem[]; onAnswer: OnAnswer }) {
	return items.map((item, index) => {
		const key =
			item.kind === "tool" || item.kind === "approval" ? `${item.kind}-${item.callId}` : `${item.kind}-${index}`;
		switch (item.kind) {
			case "text":
				// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify in renderMarkdown
				return <div key={key} className="text" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text) }} />;
			case "tool":
				return item.subagent ? (
					<SubagentBlock key={key} item={item} subagent={item.subagent} onAnswer={onAnswer} />
				) : (
					<ToolRow key={key} item={item} />
				);
			case "approval":
				return <ApprovalCard key={key} item={item} onAnswer={onAnswer} />;
			case "error":
				return (
					<div key={key} className="turn-error" role="alert">
						{item.message}
					</div>
				);
			case "cache_miss":
				return (
					<div key={key} className="cache-miss">
						cache miss: {item.reason} · {numbers.format(item.missedTokens)} tokens not read from the cache
					</div>
				);
		}
		return null;
	});
}

/** A task call with its subagent's work. Open while it runs or waits for an answer; folded once done. */
function SubagentBlock({
	item,
	subagent,
	onAnswer,
}: {
	item: Extract<TurnItem, { kind: "tool" }>;
	subagent: Subagent;
	onAnswer: OnAnswer;
}) {
	const waiting = subagent.items.some((child) => child.kind === "approval" && child.state === "pending");
	return (
		<details className="subagent" data-testid="subagent" open={item.status === "running" || waiting}>
			<summary>
				<ToolRow item={item} />
				<span className="subagent-name">
					{subagent.agent}
					{subagent.model ? ` · ${subagent.model}` : ""}
				</span>
			</summary>
			<div className="subagent-body">
				<Items items={subagent.items} onAnswer={onAnswer} />
				{subagent.finished ? <TokenLine finished={subagent.finished} /> : null}
			</div>
		</details>
	);
}

function TurnView({ turn, onAnswer }: { turn: Turn; onAnswer: OnAnswer }) {
	return (
		<section className="turn">
			{turn.prompt ? <div className="prompt">{turn.prompt}</div> : null}
			<Items items={turn.items} onAnswer={onAnswer} />
			{turn.finished ? <TokenLine finished={turn.finished} /> : null}
		</section>
	);
}

/** Finished turns never change, so only the active one re-renders while it streams. */
const FinishedTurn = memo(TurnView);

export function Transcript({
	turns,
	onAnswer,
}: {
	turns: Turn[];
	onAnswer: (callId: string, approved: boolean) => void;
}) {
	return (
		<div className="transcript">
			{turns.map((turn, index) =>
				turn.finished ? (
					<FinishedTurn key={turn.id ?? index} turn={turn} onAnswer={onAnswer} />
				) : (
					<TurnView key={turn.id ?? index} turn={turn} onAnswer={onAnswer} />
				),
			)}
		</div>
	);
}
