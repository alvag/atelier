import { describe, expect, it } from "vitest";
import { QueuePanel } from "../src/tui/queue-panel.ts";
import { painter } from "../src/tui/style.ts";

describe("queue panel", () => {
	it("shows the queue with its edit hint, and leaves the hint out while a question is open", () => {
		const panel = new QueuePanel(painter(false));
		panel.messages = [{ id: "q1", kind: "steer", text: "use tabs" }];
		expect(panel.render(80)).toEqual([" ↳ steer: use tabs", " Shift+↑ edit"]);
		panel.asking = true;
		expect(panel.render(80)).toEqual([" ↳ steer: use tabs"]);
	});
});
