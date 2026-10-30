# Image input

## Reading an image

Give the agent an image file's path and ask it to inspect it. `read` detects PNG, JPEG, GIF and
WebP from their contents, even without a matching extension. The transcript shows
`Image: <width>×<height> (<mimeType>)`; the model receives an image attachment, not base64 text.
`offset` and `limit` apply to text files only. Other binary files still return `Binary file: <path>`.

Image results currently work through Anthropic Messages (`anthropic-api`, and OpenCode Go models
served through Messages) and Claude Code's MCP bridge. Other transports reject image results
until their image conversion is available; they never silently drop them.

The model must also accept image input. Atelier uses its loaded model catalog and explicit
fallbacks for known Claude models, including Claude Code's `opus`, `sonnet` and `haiku` aliases.
An explicit catalog `images: false` overrides a fallback. A refusal says
`Image input is not supported by <backend>/<model>.` or
`Image input support is unknown for <backend>/<model>.` Text tools remain usable.

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
