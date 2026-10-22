import { type ClientCommand, decodeClientMessage } from "@atelier/core/protocol";
import type { CommandResult } from "../shared/bridge.ts";

/**
 * Validates a command arriving from the renderer with the protocol's own
 * schema, and drops any envelope fields (id, type) the renderer sent.
 */
export function parseCommand(
	payload: unknown,
): { ok: true; command: ClientCommand } | Extract<CommandResult, { ok: false }> {
	if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
		const { id: _id, type: _type, ...command } = payload as Record<string, unknown>;
		let line: string;
		try {
			line = JSON.stringify({ ...command, type: "command", id: "renderer" });
		} catch {
			return { ok: false, error: { code: "invalid_command", message: "A command must be plain JSON." } };
		}
		const decoded = decodeClientMessage(line);
		if (decoded.ok) {
			const { id: _decodedId, type: _decodedType, ...valid } = decoded.message;
			return { ok: true, command: valid as ClientCommand };
		}
		return { ok: false, error: { code: "invalid_command", message: decoded.message } };
	}
	return { ok: false, error: { code: "invalid_command", message: "A command must be an object." } };
}

/** The URL to open in the system browser, only for http(s); anything else is not opened at all. */
export function externalUrl(url: string): string | undefined {
	try {
		const { protocol } = new URL(url);
		return protocol === "http:" || protocol === "https:" ? url : undefined;
	} catch {
		return undefined;
	}
}
