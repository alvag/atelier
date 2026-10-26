/** How much the session asks the user before a tool call. Pure: the protocol and the desktop renderer import it. */
export type PermissionMode = "normal" | "auto" | "yolo";

export const PERMISSION_MODES = ["normal", "auto", "yolo"] as const satisfies readonly PermissionMode[];
