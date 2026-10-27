// Starts server.ts as its child and stays, as npx or uvx do: closing must stop the grandchild too.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, [fileURLToPath(new URL("server.ts", import.meta.url))], { stdio: "inherit" });
// A wrapper that ignores SIGTERM, so only the process group's SIGKILL stops it.
process.on("SIGTERM", () => {});
child.on("exit", (code) => process.exit(code ?? 0));
