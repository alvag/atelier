import { useEffect, useState } from "react";
import type { HostMessage } from "../../shared/bridge.ts";

/** Placeholder until U5: shows whether the core is up. */
export function App() {
	const [status, setStatus] = useState("Starting the core...");
	useEffect(
		() =>
			window.atelier.onMessage((message: HostMessage) => {
				if (message.type === "core_ready") setStatus(`Core ${message.version} ready.`);
				if (message.type === "core_failed" || message.type === "core_exited") setStatus(message.message);
			}),
		[],
	);
	return <main>{status}</main>;
}
