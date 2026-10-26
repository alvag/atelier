import { cacheHitRate, describeRefusal } from "@atelier/core/protocol";
import { visibleText } from "@atelier/core/text";
import { memo } from "react";
import { renderMarkdown } from "./markdown.ts";
import type { Subagent, Turn, TurnItem } from "./reducer.ts";

export const UNSANDBOXED_EFFECT = "every command asks for approval in normal and auto mode";

const numbers = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** "0.4s", "12.3s", "1m 12s". */
function formatDuration(ms: number): string {
	// Below 59.95 s, so toFixed never rounds up to "60.0s".
	if (ms < 59_950) return `${(ms / 1000).toFixed(1)}s`;
	const seconds = Math.round(ms / 1000);
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function ToolRow({ item }: { item: Extract<TurnItem, { kind: "tool" }> }) {
	const mark = { running: "…", ok: "✓", error: "✗", denied: "⊘" }[item.status];
	return (
		<div className={`tool tool-${item.status}`} data-testid="tool-row">
			<span className="tool-mark">{mark}</span>
			<span className="tool-name">{item.tool}</span>
			<span className="tool-summary">{item.summary ?? JSON.stringify(item.input)}</span>
			{item.truncated ? <span className="tool-note">truncated</span> : null}
			{item.blocked?.map((cause) => (
				<div key={cause} className="tool-blocked">
					sandbox blocked: {cause}
				</div>
			))}
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
	const fileTool = item.tool === "edit" || item.tool === "write";
	// An edit's or a write's reason is the legend itself; only bash's says why it leaves the sandbox.
	const reason = item.reason === undefined || fileTool ? undefined : visibleText(item.reason);
	const title = fileTool
		? `${item.tool === "edit" ? "Edit" : "Write"} a file outside the working directory?`
		: reason
			? "Run this command outside the sandbox?"
			: "Run this command?";
	return (
		<fieldset className="approval">
			<legend>{title}</legend>
			{command.hadHidden || reason?.hadHidden ? (
				<div className="warning">
					This command contains invisible or control characters, shown below as markers. Check it carefully.
				</div>
			) : null}
			<pre>{command.text}</pre>
			{reason ? <div className="approval-reason">{reason.text}</div> : null}
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
type OnUndo = (reviewId: string) => void;

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
			<div>
				Lenses: {item.lenses.join(", ")}
				{item.lensesReason === undefined ? "" : ` (${item.lensesReason})`}
			</div>
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

function ReviewVerdict({
	item,
	result,
	onUndo,
}: {
	item: Extract<TurnItem, { kind: "review" }>;
	result: NonNullable<Extract<TurnItem, { kind: "review" }>["result"]>;
	onUndo?: OnUndo | undefined;
}) {
	if (result.verdict === "declined") return <div className="review-verdict">Review declined</div>;
	if (result.verdict === "unavailable")
		return <div className="review-verdict">Review unavailable: {describeRefusal(result)}</div>;
	const escalated = result.verdict === "escalated";
	return (
		<div className="review-verdict">
			{escalated ? (
				<div className="warning" role="alert">
					Escalated: {describeRefusal(result)}
					{result.correction && !item.undone
						? " The correction is left in your worktree. Review it before committing."
						: ""}
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
			{escalated && result.correction && item.reviewId && !item.undone && onUndo ? (
				<div className="approval-actions">
					<button type="button" onClick={() => onUndo(item.reviewId as string)}>
						Undo correction
					</button>
				</div>
			) : null}
			{item.undone ? <div>{undoneText(item.undone)}</div> : null}
			{result.followUps > 0 ? <div>{result.followUps} follow-up(s) in the receipt</div> : null}
			{result.receiptPath ? (
				<div>
					Receipt: <code>{result.receiptPath}</code>
				</div>
			) : null}
		</div>
	);
}

/** What undoing a correction put back and removed. */
function undoneText(undone: { restored: string[]; removed: string[] }): string {
	const parts = ["Correction undone"];
	if (undone.restored.length > 0) parts.push(`restored ${undone.restored.join(", ")}`);
	if (undone.removed.length > 0) parts.push(`removed ${undone.removed.join(", ")}`);
	return parts.join(" · ");
}

function ReviewBlock({
	item,
	onAnswer,
	onUndo,
}: {
	item: Extract<TurnItem, { kind: "review" }>;
	onAnswer: OnAnswer;
	onUndo?: OnUndo | undefined;
}) {
	return (
		<section className="review" data-testid="review">
			<div className="review-risk">
				Review{item.level ? ` · ${item.level} risk` : ""}
				{item.lenses.length > 0 ? ` · ${item.lenses.length} lens${item.lenses.length === 1 ? "" : "es"}` : ""}
				{item.lensesReason === undefined ? "" : `: ${item.lenses.join(", ")}`}
			</div>
			<ul>
				{item.reasons.map((reason) => (
					<li key={reason}>{reason}</li>
				))}
			</ul>
			{item.declaration?.kind === "none" ? <div>Declared none: {item.declaration.reason}</div> : null}
			{item.lensesReason === undefined ? null : <div>Lenses chosen: {item.lensesReason}</div>}
			{item.since ? <div>Changes since {item.since}</div> : null}
			{item.baseNote ? <div>{item.baseNote}</div> : null}
			{item.roles.map((role) => {
				// A role's block reuses the subagent block; it stays folded unless the role asks for an answer.
				const done = role.finished !== undefined || item.result !== undefined || item.ended === true;
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
			{item.reviewId && !item.result ? (
				<div className="review-verdict">{item.ended ? "The review stopped without a result." : "Reviewing…"}</div>
			) : null}
			{item.result ? <ReviewVerdict item={item} result={item.result} onUndo={onUndo} /> : null}
		</section>
	);
}

function VerificationBlock({
	item,
	onAnswer,
}: {
	item: Extract<TurnItem, { kind: "verification" }>;
	onAnswer: OnAnswer;
}) {
	const { result } = item;
	const open = result?.openDefects.length ?? 0;
	return (
		<section className="review verification" data-testid="verification">
			<div className="review-risk">
				Verification · {item.items.length === 1 ? "item" : "items"} {item.items.join(", ")}
			</div>
			<ul>
				{item.declaration.map((entry) => (
					<li key={`${entry.items.join(",")}-${entry.reason}`}>{entry.reason}</li>
				))}
			</ul>
			{item.rounds.map((round) => (
				<div key={round.round} className="verification-round">
					<div className="review-risk">
						Round {round.round}
						{round.ok
							? ` · ${round.defects.length === 0 ? "no defects" : `${round.defects.length} defect${round.defects.length === 1 ? "" : "s"}`}`
							: " · failed"}
						{round.correcting ? " · the agent is asked to fix them" : ""}
					</div>
					{round.ok ? null : (
						<div className="warning">
							{describeRefusal({ ...round, ...(round.error === undefined ? {} : { reason: round.error }) })}
						</div>
					)}
					<ul>
						{round.requirements.map((req) => (
							<li key={req.id} className={`requirement ${req.verdict}`}>
								{req.verdict} · {req.requirement} — {req.evidence}
							</li>
						))}
					</ul>
					{round.defects.map((defect) => (
						<div key={defect.id} className="review-finding">
							{defect.id} {defect.severity} {defect.summary}
							{defect.onBase ? " (also on the base)" : ""}
							<div>
								Reproduce: <code>{defect.reproduction}</code>
							</div>
							<div>On the change: {defect.candidate}</div>
							<div>On the base: {defect.base}</div>
						</div>
					))}
				</div>
			))}
			{item.roles.map((role) => {
				// The verifier's block reuses the subagent block; it stays folded once it is done.
				const done = role.finished !== undefined || item.result !== undefined || item.ended === true;
				const row: Extract<TurnItem, { kind: "tool" }> = {
					kind: "tool",
					callId: `${item.verifyId}-${role.agent}`,
					tool: role.agent,
					input: {},
					status: done ? "ok" : "running",
					summary: done ? "done" : "working",
				};
				return <SubagentBlock key={role.agent} item={row} subagent={role} onAnswer={onAnswer} />;
			})}
			{result ? (
				result.outcome === "passed" ? (
					<div className="review-verdict">Verification passed</div>
				) : result.outcome === "corrected" ? (
					<div className="review-verdict">Verification passed after a correction</div>
				) : result.outcome === "failed" ? (
					<div className="warning" role="alert">
						Verification failed: {describeRefusal(result)}. Needs your decision.
					</div>
				) : (
					<div className="warning" role="alert">
						Needs your decision:{" "}
						{result.cause !== undefined
							? `${describeRefusal(result)}${result.reason === undefined ? "" : ` · ${result.reason}`}`
							: open === 0 && result.reason !== undefined
								? result.reason
								: `${open} open defect${open === 1 ? "" : "s"}${result.reason === undefined ? "" : ` · ${result.reason}`}`}
					</div>
				)
			) : (
				<div className="review-verdict">{item.ended ? "The verification stopped without a result." : "Verifying…"}</div>
			)}
			{result?.costUsd === undefined ? null : <div>Verification cost ${result.costUsd.toFixed(4)}</div>}
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

/**
 * A finished turn in one line: model, wall time, total tokens and cost; the token breakdown, without the cost, folds
 * under it, with the cost by part when the turn had more than one.
 */
function UsageSummary({ finished, model }: { finished: NonNullable<Turn["finished"]>; model?: string | undefined }) {
	const { input, output, cacheRead, cacheWrite } = finished.usage;
	const head: string[] = [];
	if (model) head.push(model);
	if (finished.durationMs !== undefined) head.push(formatDuration(finished.durationMs));
	head.push(`${compact.format(input + output + cacheRead + cacheWrite)} tokens`);
	if (finished.costUsd !== undefined) head.push(`$${finished.costUsd.toFixed(4)}`);
	return (
		<details className="usage" data-testid="usage">
			<summary>{head.join(" · ")}</summary>
			<TokenLine finished={finished} />
			<PhaseList phases={finished.phases} />
		</details>
	);
}

/** One line per part of the turn: its tokens, requests and cost. A single part is the total, already shown. */
function PhaseList({ phases }: { phases: NonNullable<Turn["finished"]>["phases"] }) {
	const entries = Object.entries(phases ?? {});
	if (entries.length < 2) return null;
	return (
		<ul className="phases">
			{entries.map(([phase, spent]) => {
				const { input, output, cacheRead, cacheWrite } = spent.usage;
				const parts = [phase, `${compact.format(input + output + cacheRead + cacheWrite)} tokens`];
				if (spent.requests !== undefined) parts.push(`${spent.requests} request${spent.requests === 1 ? "" : "s"}`);
				if (spent.costUsd !== undefined) parts.push(`$${spent.costUsd.toFixed(4)}`);
				return <li key={phase}>{parts.join(" · ")}</li>;
			})}
		</ul>
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
	return <div className="tokens">tokens: {parts.join(" · ")}</div>;
}

type OnAnswer = (callId: string, approved: boolean) => void;

function Items({
	items,
	onAnswer,
	onConsent,
	onUndo,
}: {
	items: TurnItem[];
	onAnswer: OnAnswer;
	onConsent?: OnConsent;
	onUndo?: OnUndo | undefined;
}) {
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
				return <ReviewBlock key={key} item={item} onAnswer={onAnswer} onUndo={onUndo} />;
			case "verification":
				return <VerificationBlock key={`${item.kind}-${item.verifyId}`} item={item} onAnswer={onAnswer} />;
			case "sandbox_warning":
				return (
					<div key={key} className="warning sandbox-warning">
						bash runs without a sandbox ({item.reason}): {UNSANDBOXED_EFFECT}
					</div>
				);
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
				{subagent.finished ? <UsageSummary finished={subagent.finished} model={subagent.model} /> : null}
			</div>
		</details>
	);
}

function TurnView({
	turn,
	onAnswer,
	onConsent,
	onUndo,
}: {
	turn: Turn;
	onAnswer: OnAnswer;
	onConsent?: OnConsent;
	onUndo?: OnUndo | undefined;
}) {
	return (
		<section className="turn">
			{turn.prompt ? <div className="prompt">{turn.prompt}</div> : null}
			<Items items={turn.items} onAnswer={onAnswer} onUndo={onUndo} {...(onConsent ? { onConsent } : {})} />
			{turn.finished ? <UsageSummary finished={turn.finished} model={turn.finished.model} /> : null}
		</section>
	);
}

/** Finished turns never change, so only the active one re-renders while it streams. */
const FinishedTurn = memo(TurnView);

export function Transcript({
	turns,
	onAnswer,
	onConsent,
	onUndo,
}: {
	turns: Turn[];
	onAnswer: (callId: string, approved: boolean) => void;
	onConsent?: OnConsent;
	/** Undoes the correction an escalated review left in the worktree. */
	onUndo?: OnUndo;
}) {
	const consent = onConsent ? { onConsent } : {};
	return (
		<div className="transcript">
			{turns.map((turn, index) =>
				turn.finished ? (
					<FinishedTurn key={turn.id ?? index} turn={turn} onAnswer={onAnswer} onUndo={onUndo} {...consent} />
				) : (
					<TurnView key={turn.id ?? index} turn={turn} onAnswer={onAnswer} onUndo={onUndo} {...consent} />
				),
			)}
		</div>
	);
}
