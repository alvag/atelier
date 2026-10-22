import type { ChatState } from "./reducer.ts";

const MARKS: Record<string, string> = { pending: "·", in_progress: "▸", blocked: "!", done: "✓", dropped: "×" };

/** The active ODD feature: its document and every task with its status. */
export function FeaturePanel({ feature }: { feature: NonNullable<ChatState["feature"]> }) {
	const done = feature.tasks.filter((task) => task.status === "done").length;
	return (
		<aside className="feature-panel" aria-label="Feature">
			<h2>{feature.title}</h2>
			<div className="feature-path">{feature.path}</div>
			<div className="feature-progress">
				{done}/{feature.tasks.length} done
			</div>
			<ol className="feature-tasks">
				{feature.tasks.map((task) => (
					<li key={task.id} className={`feature-task task-${task.status ?? "unknown"}`} data-testid="feature-task">
						<span className="task-mark">{MARKS[task.status ?? ""] ?? "?"}</span>
						<span className="task-id">{task.id}</span>
						<span className="task-title">{task.title}</span>
						{task.commit ? <code className="task-commit">{task.commit}</code> : null}
					</li>
				))}
			</ol>
		</aside>
	);
}
