import type { PreparedImage } from "@atelier/core";
import { expect, it } from "vitest";
import { PromptImages } from "../src/tui/prompt-images.ts";
import { png } from "./support/png.ts";

const image = (red = 255): PreparedImage => ({
	image: { mimeType: "image/png", data: png(red).toString("base64") },
	width: 1,
	height: 1,
	animated: false,
});

it("sends each managed image once, in marker order, and leaves literal markers alone", () => {
	const draft = new PromptImages();
	const first = image();
	const second = image(0);
	const a = draft.add("", [first]);
	const b = draft.add(a, [second]);
	expect(draft.attach(`${b}${a}${b} [Image #90]`)).toMatchObject({
		prompt: " [Image #90]",
		images: [second.image, first.image],
	});
});

it("does not charge repeated references as extra attachments", () => {
	const draft = new PromptImages();
	const marker = draft.add("", [image()]);
	const text = Array(20).fill(marker).join(" ");
	const next = draft.add(text, [image(0)]);
	expect(draft.attach(`${text} ${next}`)?.images).toHaveLength(2);
});

it("preserves typed whitespace but sends image-only drafts without a blank text part", () => {
	const draft = new PromptImages();
	const marker = draft.add("", [image()]);
	expect(draft.attach(`  describe\n${marker}`)?.prompt).toBe("  describe\n");
	expect(draft.attach(` ${marker}\n`)?.prompt).toBe("");
});

it("keeps in-flight bytes for retry and releases only the accepted snapshot", () => {
	const draft = new PromptImages();
	const a = draft.add("", [image()]);
	const sent = draft.attach(a);
	expect(sent).toBeDefined();
	const b = draft.add("", [image(0)]);
	if (!sent) throw new Error("missing snapshot");
	draft.keep(sent);
	expect(draft.attach(a)?.images).toEqual(sent.images);
	draft.release(sent);
	expect(draft.attach(a)).toBeUndefined();
	expect(draft.attach(b)?.images).toEqual([image(0).image]);
	draft.reset();
	expect(draft.attach(b)).toBeUndefined();
});

it("checks the count again when a failed snapshot is merged with a newer draft", () => {
	const draft = new PromptImages();
	const a = draft.add(
		"",
		Array.from({ length: 20 }, () => image()),
	);
	const sent = draft.attach(a);
	const b = draft.add("", [image(0)]);
	if (!sent) throw new Error("missing snapshot");
	draft.keep(sent);
	expect(() => draft.attach(`${a} ${b}`)).toThrow(/at most 20/);
	expect(draft.attach(a)?.images).toHaveLength(20);
});

it("checks normalized bytes on admission and on a restored send, including the exact limit", () => {
	const draft = new PromptImages();
	const large = image();
	// A fake normalizer result exercises the byte budget without a large encoded-image fixture.
	large.image.data = Buffer.alloc(4 * 1024 * 1024).toString("base64");
	const a = draft.add("", Array(5).fill(large));
	expect(() => draft.add(a, [large])).toThrow(/20 MiB/);
	const sent = draft.attach(a);
	const b = draft.add("", [large]);
	if (!sent) throw new Error("missing snapshot");
	draft.keep(sent);
	expect(() => draft.attach(`${a} ${b}`)).toThrow(/20 MiB/);
	expect(draft.attach(a)?.images).toHaveLength(5);
});
