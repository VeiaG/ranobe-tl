# ranobe-tl

Translates web novels chapter by chapter with an LLM (OpenAI, Anthropic or Google), keeping names and terms consistent through a glossary that grows as the translation goes.

- **strictly sequential**: terms found in chapter N are already known in chapter N+1
- **glossary in SQLite** (`glossary.db` in the novel folder); only terms that occur in the current chunk go into the prompt
- **every chunk is validated** right after generation and retried with feedback: length ratio, untranslated text, repetition loops, leaked tags / JSON / glossary annotations, truncated output
- **the model reports new terms** in a `<terms>` block, and code applies them by these rules:
  - new term → added (spelling variants of an existing term are not added)
  - gender unknown → m/f → applied retroactively
  - gender m ↔ f → applied from this chapter only if the model quotes evidence that really exists in the source, otherwise queued
  - a different translation for an existing term → queued for review
  - locked terms never change
- **gender is stored per chapter** (`m@1 → f@840`), so re-translating old chapters keeps the old gender

## Install

Requires Node.js 22.15 or newer.

```sh
npm install -g ranobe-tl
```

## Quick start

```sh
mkdir my-novel && cd my-novel

# get the source chapters, either:
ranobe-tl lncrawl                  # list novels downloaded with the lightnovel-crawler GUI
ranobe-tl lncrawl "returnee"       # unpack one into chapters/00001.txt ... and create novel.json
# or put chapters/00001.txt ... here yourself and run:
ranobe-tl init                     # create novel.json

echo OPENAI_API_KEY=sk-... > .env  # or ANTHROPIC_API_KEY / GOOGLE_GENERATIVE_AI_API_KEY

ranobe-tl translate --only 1-3     # try a few chapters first
ranobe-tl glossary list            # see what the model collected
ranobe-tl translate                # the whole range from novel.json
```

Source files: `chapters/00001.txt`, first line is the chapter title.
Output: `translation/00001.json` → `{ "content": "...", "title": "..." }`.

`.env` is read from the novel folder, then from the current directory.

## Commands

```
ranobe-tl init
ranobe-tl lncrawl [title|id] [--force] [--lncrawl-dir DIR]
ranobe-tl translate [--from N] [--to N] [--only 1,5,10-12] [--force] [--retry-failed]
ranobe-tl check [--delete]
ranobe-tl status
ranobe-tl glossary <subcommand>
```

All commands work in the current directory; `--dir PATH` points them at another novel folder.

**translate** skips chapters that already have a translation unless `--force`. Chapters that fail validation after `maxAttempts` are recorded as failed; `--retry-failed` translates only those.
Ctrl+C once finishes the current chapter and stops; twice aborts the request in flight (that chapter is not saved). The next run continues where it stopped.

**check** audits existing translations with the same rules the translator uses. `--delete` removes the bad ones and marks them failed, so `translate --retry-failed` redoes them.

**status** shows done / failed / skipped chapters and the number of glossary changes waiting for review.

**lncrawl** reads the data of the [lightnovel-crawler](https://github.com/lncrawl/lightnovel-crawler) GUI directly (read-only; it can stay open). It looks in `LNCRAWL_DATA_PATH`, `%APPDATA%\LNCrawl`, `~/.lncrawl`, or `--lncrawl-dir`. Existing chapter files are kept unless `--force`. When there is no `novel.json` yet, it creates one with the chapter range, title and synopsis.

### glossary

```
glossary import [meta.json]          import an old flat {"term": "переклад (чоловік)"} memory file
glossary export [file.json]          dump the glossary as JSON
glossary list [query] [--type T]     list / search terms
glossary show <term>                 term details and its change history
glossary changes [--all]             queued changes (translation / gender) to review
glossary accept <id...>              apply queued changes
glossary reject <id...>
glossary set <term> [--target X] [--type T] [--gender m|f|unknown --from N] [--note X]
glossary lock <term> | unlock <term>
glossary delete <term>
```

Term types: `person`, `place`, `organization`, `technique`, `item`, `rank`, `creature`, `other`.

## Providers

| `provider` | default `model` | API key variable |
|---|---|---|
| `openai` (default) | `gpt-6-luna` | `OPENAI_API_KEY` |
| `anthropic` | `claude-opus-5-5` | `ANTHROPIC_API_KEY` |
| `google` | none, set `model` | `GOOGLE_GENERATIVE_AI_API_KEY` |

- `baseURL` points any provider at a compatible endpoint (proxy, OpenRouter, ...).
- `effort` maps to OpenAI `reasoningEffort` and Anthropic `effort`; Google ignores it. Translation rarely needs much reasoning, so `low` is a good start.
- **anthropic**: the system prompt is marked for prompt caching. Current Claude models reject `temperature`, leave it unset.
- **google**: safety thresholds are set to `BLOCK_NONE`, otherwise fight scenes get whole chapters blocked. Blocks for prohibited content cannot be turned off.

## novel.json

Only `range` is required.

| key | default | |
|---|---|---|
| `range` | | `{ "start": 1, "end": 360 }` |
| `provider` | `openai` | `openai`, `anthropic`, `google` |
| `model` | per provider | see above |
| `apiKeyEnv` | per provider | name of the env variable with the key |
| `baseURL` | | custom endpoint |
| `effort` | | `low` … `max` |
| `temperature` | | |
| `maxOutputTokens` | 32000 | per request; a full chapter needs about 10–15k |
| `sourceLanguage` / `targetLanguage` | English / Ukrainian | |
| `novel` | | `{ "title", "synopsis" }`: background for the model (filled by `lncrawl`) |
| `instructions` | | appended to the system prompt |
| `fixedTerms` | `{}` | `{ "source": "translation" }`: always sent, never changed |
| `stringsToRemove` | `[]` | exact strings cut from the source before translation |
| `patternsToRemove` | translator/editor credit lines | regexes (flags `gim`) cut from the source; setting this replaces the default |
| `chunkSize` | 15000 | max characters per request; longer chapters are split on paragraphs |
| `contextChars` | 1000 | tail of the previous chunk's translation sent for continuity |
| `maxAttempts` | 3 | per chunk |
| `validation.minRatio` / `maxRatio` | 0.8 / 1.15 | allowed translation / source length |
| `validation.maxLatinPercent` | 3 | share of Latin letters in the output; set 100 for Latin-script targets |
| `validation.maxRepeatSpan` | 200 | max characters of one phrase repeated back to back ("the the the …") |
| `validation.minSourceChars` | 1000 | shorter sources are skipped |
| `debug.savePrompts` | false | save every prompt and raw response to `debug.folder` |
| `debug.folder` | `debug` | |
| `inputFolder` / `outputFolder` | `chapters` / `translation` | |
| `glossaryFile` | `glossary.db` | |
| `filePad` | 5 | digits in chapter file names |

Before translation the source is also cleaned automatically: a title repeated on the next line (also without the "Chapter N" prefix) is dropped, extra blank lines are collapsed.

Example:

```json
{
    "range": { "start": 1, "end": 360 },
    "provider": "anthropic",
    "effort": "low",
    "patternsToRemove": ["^Translate to$", "^(Previous|Next)$"],
    "novel": { "title": "Everyone Else Is A Returnee", "synopsis": "..." }
}
```

## Development

```sh
pnpm install
pnpm test
pnpm dev translate --dir ../my-novel   # run from source
pnpm build
```

## License

MIT
