import { useEffect, useState } from "react";
import type { HostMessage } from "../../shared/bridge.ts";

function describe(message: HostMessage): string | undefined {
	if (message.type === "core_ready") return `Core ${message.version} ready.`;
	if (message.type === "core_failed" || message.type === "core_exited") return message.message;
	return undefined;
}

/** Placeholder until U5: shows whether the core is up. */
export function App() {
	const [status, setStatus] = useState("Starting the core...");
	useEffect(() => {
		const unsubscribe = window.atelier.onMessage((message) => {
			const text = describe(message);
			if (text) setStatus(text);
		});
		// The status may have been sent before this subscription existed.
		void window.atelier.getStatus().then((current) => {
			const text = current && describe(current);
			if (text) setStatus(text);
		});
		return unsubscribe;
	}, []);
	return <main>{status}</main>;
}
