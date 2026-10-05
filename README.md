# ranobe-tl

Translates web novels chapter by chapter with an LLM, keeping names and terms consistent through a glossary that grows as the translation goes.

- strictly sequential: terms found in chapter N are used in chapter N+1
- the glossary lives in SQLite (`glossary.db` in the novel folder); only terms that occur in the current chunk go into the prompt
- every chunk is validated right after generation (length ratio, untranslated text, leaked tags/JSON/annotations) and retried with feedback
- the model reports new terms in a `<terms>` block, and code applies them by these rules:
  - new term → added (spelling variants of an existing term are not added)
  - gender unknown → m/f → applied retroactively
  - gender m ↔ f → applied from this chapter only if the model quotes evidence that really exists in the source, otherwise queued
  - a different translation for an existing term → queued for review
  - locked terms never change
- gender is stored per chapter (`m@1 → f@840`), so re-translating old chapters keeps the old gender

## Usage

```sh
cd my-novel            # chapters/00001.txt ...
ranobe-tl init         # creates novel.json
echo OPENAI_API_KEY=sk-... > .env
ranobe-tl glossary import meta.json   # optional: old flat {"term": "переклад (чоловік)"} memory
ranobe-tl translate
ranobe-tl status
ranobe-tl glossary changes            # review queued changes
ranobe-tl glossary accept 3 4
ranobe-tl check                       # audit existing translations
```

Output: `translation/00001.json` → `{ "content": "...", "title": "..." }`.

## novel.json

| key | default | |
|---|---|---|
| `range` | — | `{ "start": 1, "end": 2276 }` |
| `model` | `gpt-4.1` | |
| `baseURL` | | OpenAI-compatible endpoint (OpenRouter etc.) |
| `apiKeyEnv` | `OPENAI_API_KEY` | |
| `sourceLanguage` / `targetLanguage` | English / Ukrainian | |
| `chunkSize` | 15000 | chars per request |
| `maxAttempts` | 3 | per chunk |
| `contextChars` | 1000 | tail of the previous chunk's translation passed for continuity |
| `stringsToRemove` | `[]` | exact strings removed from the source |
| `patternsToRemove` | translator/editor credits | regexes removed from the source |
| `fixedTerms` | `{}` | always sent, never changed |
| `instructions` | | appended to the system prompt |
| `validation` | `minRatio 0.8, maxRatio 1.15, maxLatinPercent 3, minSourceChars 1000` | |
| `debug.savePrompts` | false | dumps prompts and raw outputs to `debug/` |
| `inputFolder` / `outputFolder` / `glossaryFile` / `filePad` | chapters / translation / glossary.db / 5 | |

`maxLatinPercent` assumes a non-Latin target language; set it to 100 to disable.
