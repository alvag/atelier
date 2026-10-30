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

## Attaching images in the TUI

Paste an image file's path into the editor to attach it as `[Image #n]` at the cursor.
Raw paths with spaces, shell-quoted or escaped paths, `~/` paths and local `file://` URLs work;
a paste can also contain several quoted paths. Use `./name` for a relative filename without an
extension. Ordinary text and non-image paths stay text.
On macOS, Ctrl+V attaches an image from the clipboard instead: PNG or TIFF, normalized like any
image and counted in the same limits. It reads the image only, never text, so paste text with the
terminal's own paste (Cmd+V). An empty or unsupported clipboard says so and leaves the draft
unchanged; a read that fails or takes more than 3 seconds shows an error. Elsewhere Ctrl+V says it
is macOS only. Ctrl+V does nothing while a question is open. Opening any question cancels active
and queued clipboard reads; their results leave the question and hidden editor draft untouched,
even if the question closes before the read finishes.
Delete a whole marker to remove its attachment. A prompt can contain images without text.

Enter or Alt+Enter sends the text and native images; the transcript keeps the visible markers.
Images cannot be queued: while a turn runs, the draft stays in the editor with
`Images cannot be queued. Wait for the current turn to finish.` A refused send restores the
submitted draft and its bytes alongside any newer typing; an accepted send does not erase newer typing.
Image prompts are not added to editor history, so recalling text never silently reattaches pixels.

If Enter arrives during preparation, the wait message names the source currently being read:
`still reading the clipboard image; press Enter again in a moment` or
`still reading the pasted file; press Enter again in a moment`. Wait for it to finish and press
Enter again. An edit or
cursor move cancels an unfinished paste or clipboard read with a note to try again; Ctrl+C aborts the read. New sessions and quitting
discard pending results rather than inserting them into a different draft.

## Images with a prompt over RPC

`session.send` accepts optional `images: [{ mimeType, data }]` alongside `prompt`. MIME types are
`image/png`, `image/jpeg`, `image/gif` and `image/webp`; `data` is canonical standard base64,
without a data-URL prefix or whitespace. An empty prompt requires at least one image. Existing
text-only commands and protocol version 7 are unchanged.

Before answering with a `turnId`, the server checks the effective model and prepares the images
within the limits below, then checks the model again. Invalid command shapes return
`invalid_command`; invalid image bytes or preparation limits return `invalid_image`; an unknown
or unsupported model returns `image_input_unsupported`. None starts a turn or records a prompt.

Images cannot be queued. An image send during a turn or another image preparation returns `busy`:
`Images cannot be queued. Wait for the current turn to finish.` Keep the draft on any failed
response. During preparation, commands that start turns or change configuration also return
`busy`; an in-flight configuration change prevents image preparation from starting. Interrupting
preparation returns `interrupted`; closing the session or disconnecting returns `session_closed`.
Background notices wait until preparation ends rather than starting a competing turn.

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

Responses uses an **8,192-token allowance per unmeasured image that is actually sent to the current
model** for context and compaction-tail estimates, rather than treating base64 as text. Text keeps its
character-based estimate. This is a compaction heuristic, not a billing estimate: API-reported usage
replaces it after a response, including the first response after resuming.

Automatic threshold compaction is deferred for these allowances: when the tokens excluding the
allowances for images the API has not yet measured do not exceed the threshold, the request is sent
and Atelier waits for actual usage, even if the allowances would pass it. This includes the first
request after resuming a history with many images. The allowances still count in the reported
context size and in choosing the retained tail. A request that really exceeds the context window
still triggers the existing overflow compaction and one retry.

An image the current model does not accept counts as its omission notice text, not as an allowance,
for the context size, the retained-tail cut and the compacted-history estimate alike. The saved
bytes are untouched: each request builds its own view, so returning to an image-capable model sends
the original images again.

## Resuming prompt images

Saved prompt entries carry an optional `imageCount`, not image bytes. RPC resume returns that count
in `entries`; normalized pixels remain in the backend resume state (or Claude Code's own transcript).
The CLI and TUI replay show `[Image #n]` markers for that count, including image-only prompts,
without duplicating markers already present in the saved text. These are transcript labels,
not attachments in the new draft.
A resumed conversation is already history: changing backend before its next prompt still summarizes
it rather than starting the new backend empty.

The next turn reports recoverable `image_history_unavailable` if earlier image prompts have no
backend resume state, including an empty Messages history: reattach those images. Successful
main-agent compaction reports `image_history_summarized` because older images may have become text;
a summary-only backend handoff uses the same code and says its images were not carried over.
Failed compactions and subagent compactions do not issue this warning.

Saved sessions can contain normalized image bytes. Treat saved or exported histories as sensitive.

## Preparation and limits

The CLI's pasted-path preparer resolves raw paths (including spaces), shell-quoted or escaped
paths, `~/` paths and local `file://` URLs without shell evaluation. A paste must name only
regular image files; ordinary text, missing paths and non-images stay text. Corrupt image data
reports a preparation error. Multiple paths are prepared sequentially within the same batch limits.
Draft snapshots check those limits again before sending, including a refused send restored alongside
newer text or images. Repeated references to one marker count as one image; deleting its marker
drops the attachment. A snapshot retains its bytes until the send is accepted or restored.
- A prompt batch accepts at most **20 images** and **20 MiB of normalized image bytes**, before
  base64 encoding. Preparation checks canonical base64 and source size before decoding, processes
  images sequentially and stops after cancellation before preparing the next image.
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
