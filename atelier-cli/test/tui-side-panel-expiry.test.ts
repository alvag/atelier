import type { AtelierEvent } from "@atelier/core";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidePanel } from "../src/tui/side-panel-view.ts";
import { painter } from "../src/tui/style.ts";
import { activeTheme, ink } from "../src/tui/theme.ts";

function view() {
	let columns = 140;
	const requestRender = vi.fn();
	const panel = new SidePanel(
		{ requestRender } as unknown as TUI,
		ink(activeTheme, false, "truecolor"),
		painter(false),
		{
			open: true,
			columns: () => columns,
			context: () => ({}),
		},
	);
	const finish = (id: string, notified = false) =>
		panel.event({
			type: "job_finished",
			jobId: id,
			label: id,
			status: "exited",
			exitCode: 0,
			durationMs: 1,
			notified,
			waiting: notified ? 1 : 0,
			seq: 1,
			turnId: "t",
		} as AtelierEvent);
	return {
		panel,
		requestRender,
		finish,
		resize: (to: number) => {
			columns = to;
			panel.syncExpiryTimer();
		},
	};
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("finished side panel row deadlines", () => {
	it("requests one frame at each next expiry, without a polling timer", () => {
		const v = view();
		v.finish("first");
		vi.advanceTimersByTime(10_000);
		v.finish("second");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(49_999);
		expect(v.requestRender).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(v.requestRender).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(10_000);
		expect(v.requestRender).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("unrefs the expiry timeout so it cannot keep the process alive", () => {
		const timeout = vi.spyOn(globalThis, "setTimeout");
		const v = view();
		v.finish("first");
		const handle = timeout.mock.results.at(-1)?.value as NodeJS.Timeout;
		expect(handle).toBeDefined();
		expect(handle.hasRef()).toBe(false);
		v.panel.stop();
		timeout.mockRestore();
	});

	it("does not rearm the same deadline on frames or unrelated events", () => {
		const timeout = vi.spyOn(globalThis, "setTimeout");
		const v = view();
		v.finish("first");
		const calls = timeout.mock.calls.length;
		v.panel.syncExpiryTimer();
		v.panel.event({ type: "jobs_status", waiting: 0 } as AtelierEvent);
		expect(timeout.mock.calls.length).toBe(calls);
		v.panel.stop();
		timeout.mockRestore();
	});

	it("has no expiry timer for unread notices and uses the original end after reading", () => {
		const v = view();
		v.finish("notice", true);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(60_001);
		v.panel.event({ type: "jobs_status", waiting: 0 } as AtelierEvent);
		expect(vi.getTimerCount()).toBe(0);
		expect(v.requestRender).not.toHaveBeenCalled();
	});

	it("reading a notice before expiry schedules only its remaining time", () => {
		const v = view();
		v.finish("notice", true);
		vi.advanceTimersByTime(40_000);
		v.panel.event({ type: "jobs_status", waiting: 0 } as AtelierEvent);
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(19_999);
		expect(v.requestRender).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(v.requestRender).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("cancels while hidden or too narrow and recomputes when shown", () => {
		const v = view();
		v.finish("first");
		v.panel.open = false;
		v.panel.syncExpiryTimer();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(10_000);
		v.panel.open = true;
		v.panel.syncExpiryTimer();
		expect(vi.getTimerCount()).toBe(1);
		v.resize(100);
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(50_000);
		v.resize(140);
		expect(vi.getTimerCount()).toBe(0);
		expect(v.requestRender).not.toHaveBeenCalled();
	});

	it("cancels on Session and rearms on Status without changing the deadline", () => {
		const v = view();
		v.finish("first");
		v.panel.toggleTab();
		expect(vi.getTimerCount()).toBe(0);
		vi.advanceTimersByTime(15_000);
		v.panel.toggleTab();
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(45_000);
		expect(v.requestRender).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("clears deadlines on reset and stop, without rearming after stop", () => {
		const v = view();
		v.finish("first");
		v.panel.reset();
		expect(vi.getTimerCount()).toBe(0);
		v.finish("second");
		v.panel.stop();
		v.panel.syncExpiryTimer();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the running-row tick separate from the expiry deadline", () => {
		const v = view();
		v.panel.event({ type: "job_started", jobId: "running", label: "running" } as AtelierEvent);
		v.finish("first");
		expect(vi.getTimerCount()).toBe(2);
		vi.advanceTimersByTime(1_000);
		expect(v.requestRender).toHaveBeenCalledTimes(1);
		v.panel.stop();
		expect(vi.getTimerCount()).toBe(0);
	});
});
