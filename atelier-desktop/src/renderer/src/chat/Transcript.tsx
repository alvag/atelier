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

type OnConsent = (reviewId: string, answer: "granted" | "declined") => void;

const CONSENT_STATE = { granted: "Review requested", declined: "Not now", closed: "Closed" } as const;

function ConsentCard({
	item,
	onConsent,
}: {
	item: Extract<TurnItem, { kind: "review_consent" }>;
	onConsent: OnConsent;
}) {
	return (
		<fieldset className="approval review-consent">
			<legend>Review this change?</legend>
			<div>Risk: {item.level}</div>
			<ul>
				{item.reasons.map((reason) => (
					<li key={reason}>{reason}</li>
				))}
			</ul>
			<div>Lenses: {item.lenses.join(", ")}</div>
			{item.state === "pending" ? (
				<div className="approval-actions">
					<button type="button" onClick={() => onConsent(item.reviewId, "granted")}>
						Review this change
					</button>
					<button type="button" onClick={() => onConsent(item.reviewId, "declined")}>
						Not now
					</button>
				</div>
			) : (
				<div className="approval-state">{CONSENT_STATE[item.state]}</div>
			)}
		</fieldset>
	);
}

function ReviewVerdict({ result }: { result: NonNullable<Extract<TurnItem, { kind: "review" }>["result"]> }) {
	if (result.verdict === "declined") return <div className="review-verdict">Review declined</div>;
	if (result.verdict === "unavailable")
		return <div className="review-verdict">Review unavailable: {result.reason ?? "no reason given"}</div>;
	const escalated = result.verdict === "escalated";
	return (
		<div className="review-verdict">
			{escalated ? (
				<div className="warning" role="alert">
					Escalated: {result.reason ?? "no reason given"}
					{result.correction ? " The correction is left in your worktree. Review it before committing." : ""}
				</div>
			) : (
				<div>
					Approved
					{result.correction ? ` · corrected ${result.correction.used}/${result.correction.budget} lines` : ""}
				</div>
			)}
			{result.findings.map((found) => (
				<div key={found.id} className="review-finding">
					{found.id} {found.severity} {found.path}
					{found.line === undefined ? "" : `:${found.line}`} — {found.claim}
				</div>
			))}
			{result.followUps > 0 ? <div>{result.followUps} follow-up(s) in the receipt</div> : null}
			{result.receiptPath ? (
				<div>
					Receipt: <code>{result.receiptPath}</code>
				</div>
			) : null}
		</div>
	);
}

function ReviewBlock({ item, onAnswer }: { item: Extract<TurnItem, { kind: "review" }>; onAnswer: OnAnswer }) {
	return (
		<section className="review" data-testid="review">
			<div className="review-risk">
				Review{item.level ? ` · ${item.level} risk` : ""}
				{item.lenses.length > 0 ? ` · ${item.lenses.length} lens${item.lenses.length === 1 ? "" : "es"}` : ""}
			</div>
			<ul>
				{item.reasons.map((reason) => (
					<li key={reason}>{reason}</li>
				))}
			</ul>
			{item.roles.map((role) => {
				// A role's block reuses the subagent block; it stays folded unless the role asks for an answer.
				const done = role.finished !== undefined || item.result !== undefined;
				const row: Extract<TurnItem, { kind: "tool" }> = {
					kind: "tool",
					callId: `${item.reviewId}-${role.agent}`,
					tool: role.agent,
					input: {},
					status: done ? "ok" : "running",
					summary: done ? "done" : "working",
				};
				return <SubagentBlock key={role.agent} item={row} subagent={role} onAnswer={onAnswer} />;
			})}
			{item.reviewId && !item.result ? <div className="review-verdict">Reviewing…</div> : null}
			{item.result ? <ReviewVerdict result={item.result} /> : null}
		</section>
	);
}

/** A separator in the transcript: older history above it was summarized. */
function CompactionRow({ item }: { item: Extract<TurnItem, { kind: "compaction" }> }) {
	if (item.state === "running")
		return (
			<div className="compaction running">
				Compacting context… ({item.reason}, {numbers.format(item.tokensBefore)} tokens)
			</div>
		);
	if (item.state === "failed")
		return (
			<div className="compaction failed" role="alert">
				Compaction failed: {item.error ?? "no reason given"}
			</div>
		);
	const before = numbers.format(item.tokensBefore);
	const parts = [
		item.tokensAfter === undefined
			? `${before} tokens before`
			: `${before} → ${numbers.format(item.tokensAfter)} tokens`,
	];
	if (item.kept > 0) parts.push(`${item.kept} message${item.kept === 1 ? "" : "s"} kept`);
	if (item.costUsd !== undefined) parts.push(`$${item.costUsd.toFixed(4)}`);
	return <div className="compaction">Context compacted · {parts.join(" · ")}</div>;
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

function Items({ items, onAnswer, onConsent }: { items: TurnItem[]; onAnswer: OnAnswer; onConsent?: OnConsent }) {
	return items.map((item, index) => {
		const key =
			item.kind === "tool" || item.kind === "approval"
				? `${item.kind}-${item.callId}`
				: item.kind === "review_consent"
					? `${item.kind}-${item.reviewId}`
					: `${item.kind}-${index}`;
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
			case "review_consent":
				return <ConsentCard key={key} item={item} onConsent={onConsent ?? (() => {})} />;
			case "review":
				return <ReviewBlock key={key} item={item} onAnswer={onAnswer} />;
			case "error":
				return (
					<div key={key} className="turn-error" role="alert">
						{item.message}
					</div>
				);
			case "cache_miss":
				return item.expected ? (
					<div key={key} className="cache-miss expected">
						cache miss after compaction: {item.reason} (expected)
					</div>
				) : (
					<div key={key} className="cache-miss">
						cache miss: {item.reason} · {numbers.format(item.missedTokens)} tokens not read from the cache
					</div>
				);
			case "compaction":
				return <CompactionRow key={key} item={item} />;
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

function TurnView({ turn, onAnswer, onConsent }: { turn: Turn; onAnswer: OnAnswer; onConsent?: OnConsent }) {
	return (
		<section className="turn">
			{turn.prompt ? <div className="prompt">{turn.prompt}</div> : null}
			<Items items={turn.items} onAnswer={onAnswer} {...(onConsent ? { onConsent } : {})} />
			{turn.finished ? <TokenLine finished={turn.finished} /> : null}
		</section>
	);
}

/** Finished turns never change, so only the active one re-renders while it streams. */
const FinishedTurn = memo(TurnView);

export function Transcript({
	turns,
	onAnswer,
	onConsent,
}: {
	turns: Turn[];
	onAnswer: (callId: string, approved: boolean) => void;
	onConsent?: OnConsent;
}) {
	const consent = onConsent ? { onConsent } : {};
	return (
		<div className="transcript">
			{turns.map((turn, index) =>
				turn.finished ? (
					<FinishedTurn key={turn.id ?? index} turn={turn} onAnswer={onAnswer} {...consent} />
				) : (
					<TurnView key={turn.id ?? index} turn={turn} onAnswer={onAnswer} {...consent} />
				),
			)}
		</div>
	);
}
