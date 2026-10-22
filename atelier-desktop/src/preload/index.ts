import type { ClientCommand } from "@atelier/core/protocol";
import { contextBridge, ipcRenderer } from "electron";
import { type AtelierBridge, type HostMessage, IPC } from "../shared/bridge.ts";

const bridge: AtelierBridge = {
	request: (command: ClientCommand) => ipcRenderer.invoke(IPC.request, command),
	onMessage(listener) {
		const handler = (_event: unknown, message: HostMessage) => listener(message);
		ipcRenderer.on(IPC.message, handler);
		return () => ipcRenderer.off(IPC.message, handler);
	},
	restartCore: () => ipcRenderer.invoke(IPC.restart),
	pickFolder: () => ipcRenderer.invoke(IPC.pickFolder),
};

contextBridge.exposeInMainWorld("atelier", bridge);
