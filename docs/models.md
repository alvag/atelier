# Model catalog

The models `/model` offers, and what Atelier knows of each (its window, its price, its thinking levels, whether it takes images), come from two places: the lists in the code, and a catalog refreshed from models.dev and from the providers. A model outside both still works with `--model` or `/model <name>`; it just runs with the defaults (a 200000-token window, or Codex's 272000; no price; no level sent).

## The lists

Each backend offers its list in the code (`BACKEND_MODELS`; its first model is the default) and the models its provider listed that the code lacks, newest first: the models with a release date (models.dev's `release_date`) by it, then the rest by the version in their name (`claude-opus-5-5` is 5.5, `glm-5.3-flash` 5.3; a date in the id, as in `claude-haiku-4-5-20251001`, is not a version), ties in the order they came in. The code's lists never go away, whatever a provider answers or fails to answer. `options.list` reads both (see [profiles](profiles.md)).

`claude-code` lists versioned ids only: `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-haiku-5-5` in the code (what `opus`, `sonnet` and `haiku` stand for, which every plan has), and what the subscription offers once a session lists it. A row of an alias in `supportedModels()` (`opus`, `fable`) is listed as the model it stands for now (`resolvedModel`, without `[1m]`), and the model keeps the alias; `default` stands for the account's first model, so it only lists that model. The aliases are not listed, but they still work written: `--model sonnet`, `/model claude-code/sonnet`. A list cached before the aliases were resolved is asked again at the next session.

| Backend         | Listed by                                                                                                                                                                                                                                      | Asked with                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code`   | Claude Code itself (`supportedModels()` of the Agent SDK): the first session of an interval lends its running process, so no process starts only to list them. Its levels come along.                                                          | The subscription session the backend already runs.                                                                                                                      |
| `anthropic-api` | `GET https://api.anthropic.com/v1/models`: each model's window (`max_input_tokens`), levels (`capabilities.effort`) how its thinking is turned off (`capabilities.thinking.types`) and whether it takes images (`capabilities.image_input`).   | The API key `anthropic-api` uses, only when there is one. A key kept in the macOS Keychain is read only for `atelier models --refresh`, never in the background.        |
| `opencode-go`   | `GET https://opencode.ai/inference/go/v1/models`: the ids only.                                                                                                                                                                                | Nothing: the list needs no key. It is asked only when OpenCode Go has one (`OPENCODE_API_KEY` or `auth.json`).                                                          |
| `openai-codex`  | The Codex model catalog, `GET https://chatgpt.com/backend-api/codex/models?client_version=0.162.1`: the models the account's picker shows (`visibility: list`), each with its window, levels and whether it takes images (`input_modalities`). | The OpenAI Codex sign-in's token and account id. Sign in with ChatGPT's token only ever goes to api.openai.com, so with that sign-in alone Codex keeps the code's list. |

What a provider does not say comes from [models.dev](https://models.dev), an open catalog (`GET https://models.dev/api.json`, no credential): the long name (`name`), the release date (`release_date`), the window, the price (its tiers by prompt size included), the levels and whether it takes images (`modalities.input`) of Anthropic's and OpenCode Go's models. Codex and Claude Code serve their own windows and levels, and bill no tokens, so of models.dev's OpenAI and Anthropic models they take only the name, the release date and whether a model takes images. A cache of models.dev kept before release dates were read is asked again without its etag, so they come.

For a model in the code's tables (`pricing.ts`, the OpenCode Go table, the Codex list), the code's window, price and levels are used, whatever the catalog says: it only fills in the models the tables lack. A model only the catalog knows gets what the catalog says, each field left out when no source said it; a level the catalog does not list for it is not sent (`session_started.effort` says `unsupported`), and its thinking is turned off only where a source said how. OpenCode Go serves a model only the catalog knows through Chat Completions.

## The cache

The answers are kept in `~/.atelier/models.json`: each source's last answer and when it was asked (`{ "version": 1, "sources": { "<source>": { "checkedAt", "etag", "models" } } }`). It holds no credential and can be deleted: it is rebuilt at the next refresh. It is written whole to a temporary next to it and renamed over, so a reader never sees half a file; a hand-edited entry that is not a model is dropped alone.

When the core starts (`atelier`, the TUI, the desktop) it reads the cache, offers what it holds, and refreshes in the background, never holding up the start or a selector: each source whose answer is older than 6 hours is asked, models.dev with its etag (`If-None-Match`), each request within 4 seconds. A provider is asked only when you are signed in to it, as `/model` finds out: `ANTHROPIC_API_KEY` or `auth.json`, the Keychain asked only whether it holds a key (never for the key, so no Keychain dialog shows without you asking), `OPENCODE_API_KEY` or `auth.json`, the Codex sign-in in `auth.json`. A provider you are not signed in to is `skipped`: none of its credentials is read, and only that check runs again at the next start. Its credential is read only when its turn comes. An answer that fails, times out, is not a list, or lists no valid model (an empty list, entries without an id, a page that says there is more without saying from where) is broken and leaves the cache as it was, and the source is asked again at the next refresh. A cache entry that makes no sense is dropped alone; a cache that cannot be read at all leaves the code's lists, and a new read does not hold up the lists of the last one. Two processes refreshing at once can lose one's answer, never the file. A session that already started keeps its model's window; the new lists show at the next `/model`.

`ATELIER_MODEL_REFRESH=off` asks nothing: the lists come from the code and the cache. `ATELIER_OFFLINE` set to anything but empty or `0` (`ATELIER_OFFLINE=1`) does the same. `ATELIER_LOGIN_CHECK=off` reads no credential for the catalog: only models.dev, which takes none, is asked.

## `atelier models`

`atelier models` prints each backend's models as `/model` offers them, from the code and the cache, without asking anything:

```
claude-code · listed 2026-10-28T21:00:00.000Z
  claude-fable-5-1  (new)  images
  claude-opus-5-5  images
  ...
opencode-go · listed 2026-10-28T21:00:00.000Z
  ...
  grok-4.7  (new)  text only
  ...
```

`(new)` marks a model the code's list lacks; `images` and `text only` say whether a model takes images, where a source said it. `atelier models --refresh` asks every source first, whatever the age of its answer, and says how each went (`Refreshed: models.dev changed, anthropic-api skipped, opencode-go unchanged, openai-codex changed.`; `skipped`: not signed in, nothing asked). Claude Code's list is refreshed by its sessions only. With `ATELIER_MODEL_REFRESH=off` or `ATELIER_OFFLINE=1` it prints the variable and `: nothing was asked.` instead (`ATELIER_OFFLINE=1: nothing was asked.`). It takes no other option; `--refresh` without `models` is a usage error.

## What is sent where

- models.dev gets a plain request: your IP address and Node's user agent, nothing else.
- Each provider's list goes to that provider's own API, with the credential its backend already sends there, and only when you are signed in to it; with `ATELIER_LOGIN_CHECK=off`, never.
- Claude Code answers from the process of a session that already runs; nothing else is asked.
