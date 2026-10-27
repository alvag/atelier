import type { QueuedMessage } from "@atelier/core/protocol";
import { useState } from "react";

/** The messages queued while a turn runs, over the composer: each can be edited in place or taken off the queue. */
export function QueueList({
	queue,
	onEdit,
	onRemove,
}: {
	queue: QueuedMessage[];
	onEdit: (id: string, text: string) => void;
	onRemove: (id: string) => void;
}) {
	const [editing, setEditing] = useState<{ id: string; text: string } | undefined>(undefined);
	return (
		<ul className="queue" aria-label="Queued messages">
			{queue.map((message) => (
				<li key={message.id}>
					<span className="queue-kind">{message.kind === "steer" ? "steer" : "follow-up"}</span>
					{editing?.id === message.id ? (
						<>
							<textarea
								aria-label="Queued message"
								value={editing.text}
								onChange={(event) => setEditing({ id: message.id, text: event.target.value })}
							/>
							<button
								type="button"
								disabled={editing.text.trim() === ""}
								onClick={() => {
									onEdit(message.id, editing.text);
									setEditing(undefined);
								}}
							>
								Save
							</button>
							<button type="button" onClick={() => setEditing(undefined)}>
								Cancel
							</button>
						</>
					) : (
						<>
							<span className="queue-text">{message.text}</span>
							<button
								type="button"
								aria-label={`Edit ${message.text}`}
								onClick={() => setEditing({ id: message.id, text: message.text })}
							>
								Edit
							</button>
						</>
					)}
					<button type="button" aria-label={`Remove ${message.text}`} onClick={() => onRemove(message.id)}>
						×
					</button>
				</li>
			))}
		</ul>
	);
}
