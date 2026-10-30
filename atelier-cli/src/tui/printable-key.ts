import { decodeKittyPrintable } from "@earendil-works/pi-tui";

const SHIFT = 1;
/** Caps Lock and Num Lock do not turn a printable key into a shortcut. */
const LOCKS = 64 | 128;

/** xterm's modifyOtherKeys printable input; Ctrl, Alt and other shortcut modifiers are not text. */
function decodeModifyOtherKeys(data: string): string | undefined {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: modifyOtherKeys starts with ESC
	const match = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
	if (match === null) return undefined;
	const modifier = (Number.parseInt(match[1] ?? "", 10) - 1) & ~LOCKS;
	const codepoint = Number.parseInt(match[2] ?? "", 10);
	if ((modifier & ~SHIFT) !== 0 || !Number.isFinite(codepoint) || codepoint < 32) return undefined;
	try {
		return String.fromCodePoint(codepoint);
	} catch {
		return undefined;
	}
}

/** The prompt editor's printable-key behavior, using only pi-tui's public entry point. */
export function decodePrintableKey(data: string): string | undefined {
	return decodeKittyPrintable(data) ?? decodeModifyOtherKeys(data);
}
