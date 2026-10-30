# Image input

## Reading an image

Give the agent an image file's path and ask it to inspect it. `read` detects PNG, JPEG, GIF and
WebP from their contents, even without a matching extension. The transcript shows
`Image: <width>×<height> (<mimeType>)`; the model receives an image attachment, not base64 text.
`offset` and `limit` apply to text files only. Other binary files still return `Binary file: <path>`.

Image results work through Anthropic Messages (`anthropic-api`, and OpenCode Go models served
through Messages), OpenCode Go's Chat Completions transport, OpenAI Responses (`openai-codex`,
both sign-in variants) and Claude Code's MCP bridge. Chat Completions and Responses send tool
images in a labeled user message after all tool replies. Responses uses `input_image` data URLs
while keeping `function_call_output.output` textual; Chat uses `image_url` content parts.

The model must also accept image input. The check uses the backend's resolved model, including
its constructor default and subsequent model changes, rather than an unset Session option.
Atelier uses its loaded model catalog and explicit fallbacks for known Claude and Codex models,
including Claude Code's `opus`, `sonnet` and `haiku` aliases.
An explicit catalog `images: false` overrides a fallback. A refusal says
`Image input is not supported by <backend>/<model>.` or
`Image input support is unknown for <backend>/<model>.` Text tools remain usable.

## Changing models with image history

New image results are refused when the selected model does not accept images or its support is
unknown. In Atelier-owned history (Messages, Chat Completions and Responses), each image the
new model cannot receive becomes
`[image omitted: <model> does not accept images]` in that model's request, including nested tool
images and summary requests. A Chat Completions conversion that cannot carry an image source
(such as a Messages file id) supplies an explicit source-omission notice instead.

These substitutions do not rewrite saved history. Returning to an image-capable model or
resuming with one sends the original normalized pixels again. Compaction can still replace
older history with a summary. A text-only carried prompt marks images it cannot retain with
`[image omitted: the carried prompt is text-only; see the summary]`.

Saved sessions can contain normalized image bytes. Treat saved or exported histories as sensitive.

## Preparation and limits

- A source may contain at most **40,000,000 decoded pixels** and **20 MiB of encoded data**.
  The decoder enforces the pixel limit before allocating the full image.
- Images are oriented, stripped of metadata and resized without enlargement to at most
  **2048 pixels on the longest side** and **4 MiB of encoded output**.
- Images with an alpha channel remain PNG. For opaque images, preparation encodes PNG and
  JPEG and keeps the smaller one that fits; if neither fits, it reduces the dimensions again.
- Animated images use their first frame and say `Animated image: only the first frame was attached.`
- Directories, pipes and devices are refused before reading. Existing protected-path and
  symbolic-link protections apply to images just as they do to text.

An oversized source reports `Image exceeds the 40,000,000-pixel limit.` or
`Image exceeds the 20 MiB input limit.` An unavailable native codec reports
`image support unavailable: <cause>`; it does not prevent the core or its text tools from starting.
