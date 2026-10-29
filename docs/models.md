# Model catalog

The models `/model` offers, and what Atelier knows of each (its window, its price, its thinking levels, whether it takes images), come from two places: the lists in the code, and a catalog refreshed from models.dev and from the providers. A model outside both still works with `--model` or `/model <name>`; it just runs with the defaults (a 200000-token window, or Codex's 272000; no price; no level sent).

## The lists

Each backend offers its list in the code first (`BACKEND_MODELS`; its first model is the default), then the models its provider listed that the code lacks, in the provider's order. The code's lists never go away, whatever a provider answers or fails to answer, and the aliases `opus`, `sonnet` and `haiku` stay at the top of `claude-code`'s. `options.list` reads both (see [profiles](profiles.md)).

| Backend         | Listed by                                                                                                                                                                                                                                      | Asked with                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code`   | Claude Code itself (`supportedModels()` of the Agent SDK): the first session of an interval lends its running process, so no process starts only to list them. Its levels come along.                                                          | The subscription session the backend already runs.                                                                                                                      |
| `anthropic-api` | `GET https://api.anthropic.com/v1/models`: each model's window (`max_input_tokens`), levels (`capabilities.effort`) how its thinking is turned off (`capabilities.thinking.types`) and whether it takes images (`capabilities.image_input`).   | The API key `anthropic-api` uses, only when there is one. A key kept in the macOS Keychain is read only for `atelier models --refresh`, never in the background.        |
| `opencode-go`   | `GET https://opencode.ai/inference/go/v1/models`: the ids only.                                                                                                                                                                                | Nothing: the list needs no key. It is asked only when OpenCode Go has one (`OPENCODE_API_KEY` or `auth.json`).                                                          |
| `openai-codex`  | The Codex model catalog, `GET https://chatgpt.com/backend-api/codex/models?client_version=0.162.1`: the models the account's picker shows (`visibility: list`), each with its window, levels and whether it takes images (`input_modalities`). | The OpenAI Codex sign-in's token and account id. Sign in with ChatGPT's token only ever goes to api.openai.com, so with that sign-in alone Codex keeps the code's list. |

What a provider does not say comes from [models.dev](https://models.dev), an open catalog (`GET https://models.dev/api.json`, no credential): the window, the price (its tiers by prompt size included), the levels and whether it takes images (`modalities.input`) of Anthropic's and OpenCode Go's models. Codex's windows differ from OpenAI's API, so models.dev's OpenAI models are not read.

For a model in the code's tables (`pricing.ts`, the OpenCode Go table, the Codex list), the code's window, price and levels are used, whatever the catalog says: it only fills in the models the tables lack. A model only the catalog knows gets what the catalog says, each field left out when no source said it; a level the catalog does not list for it is not sent (`session_started.effort` says `unsupported`), and its thinking is turned off only where a source said how. OpenCode Go serves a model only the catalog knows through Chat Completions.

## The cache

The answers are kept in `~/.atelier/models.json`: each source's last answer and when it was asked (`{ "version": 1, "sources": { "<source>": { "checkedAt", "etag", "models" } } }`). It holds no credential and can be deleted: it is rebuilt at the next refresh. It is written whole to a temporary next to it and renamed over, so a reader never sees half a file; a hand-edited entry that is not a model is dropped alone.

When the core starts (`atelier`, the TUI, the desktop) it reads the cache, offers what it holds, and refreshes in the background, never holding up the start or a selector: each source whose answer is older than 6 hours is asked, models.dev with its etag (`If-None-Match`), each request within 4 seconds. A provider is asked only when you are signed in to it, as `/model` finds out: `ANTHROPIC_API_KEY` or `auth.json`, the Keychain asked only whether it holds a key (never for the key, so no Keychain dialog shows without you asking), `OPENCODE_API_KEY` or `auth.json`, the Codex sign-in in `auth.json`. A provider you are not signed in to is `skipped`: none of its credentials is read, and only that check runs again at the next start. Its credential is read only when its turn comes. An answer that fails, times out, is not a list, or lists no valid model (an empty list, entries without an id, a page that says there is more without saying from where) is broken and leaves the cache as it was, and the source is asked again at the next refresh. A cache entry that makes no sense is dropped alone; a cache that cannot be read at all leaves the code's lists, and a new read does not hold up the lists of the last one. Two processes refreshing at once can lose one's answer, never the file. A session that already started keeps its model's window; the new lists show at the next `/model`.

`ATELIER_MODEL_REFRESH=off` asks nothing: the lists come from the code and the cache. `ATELIER_OFFLINE` set to anything but empty or `0` (`ATELIER_OFFLINE=1`) does the same. `ATELIER_LOGIN_CHECK=off` reads no credential for the catalog: only models.dev, which takes none, is asked.

## `atelier models`

`atelier models` prints each backend's models as `/model` offers them, from the code and the cache, without asking anything:

```
opencode-go · listed 2026-10-28T21:00:00.000Z
  minimax-m3
  ...
  grok-4.7  (new)  text only
openai-codex · the code's list
  gpt-6-sol
  ...
```

`(new)` marks a model the code's list lacks; `images` and `text only` say whether a model takes images, where a source said it. `atelier models --refresh` asks every source first, whatever the age of its answer, and says how each went (`Refreshed: models.dev changed, anthropic-api skipped, opencode-go unchanged, openai-codex changed.`; `skipped`: not signed in, nothing asked). Claude Code's list is refreshed by its sessions only. With `ATELIER_MODEL_REFRESH=off` or `ATELIER_OFFLINE=1` it prints the variable and `: nothing was asked.` instead (`ATELIER_OFFLINE=1: nothing was asked.`). It takes no other option; `--refresh` without `models` is a usage error.

## What is sent where

- models.dev gets a plain request: your IP address and Node's user agent, nothing else.
- Each provider's list goes to that provider's own API, with the credential its backend already sends there, and only when you are signed in to it; with `ATELIER_LOGIN_CHECK=off`, never.
- Claude Code answers from the process of a session that already runs; nothing else is asked.
