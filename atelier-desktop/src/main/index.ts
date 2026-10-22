import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { RpcClient } from "@atelier/core/client";
import type { ClientCommand } from "@atelier/core/protocol";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { IPC } from "../shared/bridge.ts";
import { CoreHost } from "./core-host.ts";

const QUIT_TIMEOUT_MS = 4000;

/** The core runs on Electron's own Node (24+, which runs TypeScript natively), so no system node is needed. */
function connectCore() {
	const corePackage = createRequire(import.meta.url).resolve("@atelier/core/package.json");
	return RpcClient.connect({
		command: process.execPath,
		args: [join(dirname(corePackage), "src/server/main.ts"), "serve"],
		env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
	});
}

let window: BrowserWindow | undefined;
const host = new CoreHost({
	connect: connectCore,
	send: (message) => window?.webContents.send(IPC.message, message),
});

function createWindow(): BrowserWindow {
	const created = new BrowserWindow({
		width: 1100,
		height: 760,
		title: "Atelier",
		webPreferences: {
			preload: join(import.meta.dirname, "../preload/index.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	// Links open in the system browser, and only http(s); the app window never navigates away.
	created.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) void shell.openExternal(url);
		return { action: "deny" };
	});
	created.webContents.on("will-navigate", (event) => event.preventDefault());
	created.webContents.once("did-finish-load", () => void host.start());
	if (process.env.ELECTRON_RENDERER_URL) void created.loadURL(process.env.ELECTRON_RENDERER_URL);
	else void created.loadFile(join(import.meta.dirname, "../renderer/index.html"));
	return created;
}

ipcMain.handle(IPC.request, (_event, command: ClientCommand) => host.request(command));
ipcMain.handle(IPC.restart, () => host.restart());
ipcMain.handle(IPC.pickFolder, async () => {
	const options = { properties: ["openDirectory" as const] };
	const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
	return result.canceled ? undefined : result.filePaths[0];
});

void app.whenReady().then(() => {
	window = createWindow();
});

app.on("window-all-closed", () => app.quit());

// Close the core (and its Claude Code processes) before quitting, without hanging forever.
let quitting = false;
app.on("before-quit", (event) => {
	if (quitting) return;
	quitting = true;
	event.preventDefault();
	const timeout = new Promise((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS));
	void Promise.race([host.stop(), timeout]).finally(() => app.exit(0));
});
