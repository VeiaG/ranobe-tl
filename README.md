# ranobe-tl

Self-hosted web app that translates web novels chapter by chapter with an LLM (OpenAI, Anthropic, Google or any OpenAI-compatible endpoint), keeping names and terms consistent through a glossary that grows as the translation goes.

![Dashboard](docs/dashboard.png)

- **strictly sequential per novel, parallel across novels**: terms found in chapter N are known in chapter N+1, and several novels translate at the same time
- **glossary per novel**: only terms that occur in the current chunk go into the prompt; gender is stored per chapter (`m@1 → f@840`)
- **every chunk is validated** and retried with feedback: length ratio, untranslated text, repetition loops, leaked tags / JSON, lost paragraphs (summarized passages), truncated output
- **the model reports new terms**; new ones are added on their own, changes to existing ones wait for you in **Decisions**
- **two ways to handle those changes**, per novel: keep translating and decide later, or stop that novel until you decide (others keep running) and translate the chapter again with the answer
- **optional review of new terms** (per novel, opt-in): every new name also lands in Decisions, where you confirm it, fix its translation, type or gender, or remove it as "not a term" so it is never proposed again; can be limited to some types and to the first N chapters
- **batch mode** (per novel, Anthropic keys): terms are extracted from all chapters first, you settle only the terms the chapters disagree on, then every chapter is translated with the finished glossary through the Message Batches API at half the price
- **Telegram bot** with buttons for decisions, plus failures and finished runs; long polling, so it works behind NAT
- **sequels keep their names**: a new novel can start its glossary from another novel or a glossary file (this app's glossary.json, the CLI's meta.json or glossary.db); the last known gender holds from chapter 1, and rejected proposals and "not a term" sources come along. Terms can be added the same way to an existing novel; what it already has is kept
- **reader** with the original side by side and glossary terms highlighted, hand edits, re-translation of the chapters that use a changed term
- **translation history**: whenever a chapter's text is replaced (a new translation, an edit, a reset), the old one is kept (last 10); compare any version with the current text word by word and restore it
- **find and replace** over all translated chapters, in titles, text or both (Глава → Розділ): plain text or a regular expression, optionally keeping the case of each match; a preview shows every changed chapter first, and the old texts go to the history
- **assistant** next to it: a chat with its own model (Settings → Instance) that searches the translations and sources and proposes literal edits, e.g. an old name in every grammatical form after its translation changed; you tick the edits to apply, the old texts go to the history. Accepting a new translation of a term in Decisions offers "Fix with the assistant" with the task filled in
- **usage and costs**: every request is recorded (novel, chapter, key, model, tokens, whether validation rejected it); the Usage page shows daily spend by model, cost per chapter and what retries wasted, filtered by novel, provider, model or key. Costs come from an editable price table (Claude list prices built in), so the estimate before a run and the history stay in sync with it
- **budgets**: a total per novel and a monthly one per API key; a run pauses when it reaches either
- **instance settings** without restarts: how many novels translate at once, a limit per API key (rate limits, a local server), defaults for new novels, the Telegram bot token, a **service model** (key, model, reasoning) for helper jobs: the ✨ next to a novel's "Patterns to remove" turns a description ("Patreon links at the end of chapters") into regexes, tried on every source before you add them
- **backups as plain folders** in an S3-compatible bucket (R2, B2, MinIO, S3): translations, glossary and settings in the CLI's layout, uploaded incrementally; any folder (a backup, an export, an old CLI novel folder) imports back as a novel
- accounts: the first one is the admin, others join with invite links; API keys are stored encrypted

| | |
|---|---|
| ![Overview](docs/overview.png) | ![Reader](docs/reader.png) |
| ![Decisions](docs/decisions.png) | ![Glossary](docs/glossary.png) |

## Run it

Needs Docker with Compose. Runs on a Raspberry Pi 4/5 (arm64) too: the model runs at the provider, the Pi only coordinates.

```sh
mkdir ranobe-tl && cd ranobe-tl
curl -fsSLO https://github.com/VeiaG/ranobe-tl/releases/latest/download/compose.yml
docker compose up -d
```

Open `http://<this machine>:3000`, create the admin account, add an API key in **Settings → API keys**, create a novel and upload its chapters.

No `.env` is needed: the secret that encrypts the API keys is generated on the first start. Two containers start, the app and Postgres; the image comes ready from `ghcr.io/veiag/ranobe-tl`, nothing is built.

- [Configuration](docs/configuration.md): environment variables, where data is stored, updating, pinning a version
- [Running it on a domain](docs/deploy.md): Coolify, Caddy, Cloudflare Tunnel, nginx

Updating: `docker compose pull && docker compose up -d`.

### Backups

**Settings → Storage** keeps every novel as a folder in an S3-compatible bucket (Cloudflare R2, Backblaze B2, MinIO, AWS S3):

```
ranobe-tl/<novel>/novel.json              the CLI's config plus a "ranobeTl" block (title, decision mode, …)
ranobe-tl/<novel>/glossary.json           terms with gender history, past decisions, "not a term" sources
ranobe-tl/<novel>/translation/00001.json  { content, title }
ranobe-tl/<novel>/chapters/00001.txt      sources (optional)
```

A chapter is uploaded a minute after it is translated or edited, the glossary after changes, and every novel is checked nightly. Only changed files are sent and nothing is deleted in the bucket. The same folder downloads as a zip from the chapters page (export menu).

**New novel → Import a folder** creates a novel from a folder in the bucket or from a zip: a backup, an export, or a novel folder of the old CLI (`novel.json`, `chapters/`, `translation/`, `glossary.db` or `meta.json`), with its glossary, gender history, past decisions and chapter statuses.

The folders are what matters; for a full copy of everything (accounts, activity log) dump the database too: `docker compose exec db pg_dump -U ranobe ranobe > backup.sql`.

## Using it

**Chapters**: upload `.txt` files (first line is the title, the number comes from the file name: `00012.txt`, `Chapter 12.txt`), a `.zip` of them, a JSON array (`[{ "index", "title", "content" }]`), or paste a long text and split it at "Chapter N" lines.

**Translate** queues everything not translated yet, failed chapters, or a range (optionally translating done chapters again). **Pause** lets the chapter in flight finish; **Stop now** drops it. After 3 failed chapters in a row (a bad key, a dead endpoint) the run pauses itself.

**Publish to wuji.world** (export menu on the chapters page): sign in with the site's email and password, or paste the `payload-token` cookie for an account made with Google, pick one of the books the account can edit and a range; translated chapters are appended to the book in order. The sign-in is not saved. `WUJI_API_URL` points it at another copy of the site.

**Batch mode** is chosen when the novel is created ("Terms first, then batches"; Anthropic keys only). It does not translate chapter by chapter:
1. **Extract terms** sends every chapter to the model at once (one Message Batch). Each chapter comes back as a list of terms with a proposed translation, type, gender and a quote; nothing is translated yet.
2. Terms that every chapter agrees on go into the glossary by themselves, and so do those that match it. The rest wait in **Candidates**: several translations, a gender that changes between chapters, or a value that differs from the glossary. Each shows the variants with how many chapters use them, excerpts from the sources, and **Ask the model**, which reads the excerpts and suggests one entry with a reason (one by one, or for all of them, then "Merge as the model advises").
3. **Translate** sends the chapters as one batch with the glossary as it is then. The model only translates; it proposes nothing, so there is nothing to decide afterwards. Every part is validated as usual; a rejected part goes out again in a follow-up batch with the reason, until the attempts run out.

Titles and ranks are kept in their base form and put in the holder's gender while translating, so a title held by a woman never becomes a separate entry. Batches cost half the list price (Usage shows them as `<model>:batch`) and usually finish within an hour, at most a day. "Extract terms again" re-reads a range of chapters with the current glossary, e.g. after new chapters were uploaded.

**Glossary rules** (the same as the CLI had):
- new term → added (spelling variants of an existing term are not)
- gender unknown → m/f → applied retroactively
- gender m ↔ f → applied from this chapter if the model quotes evidence that really exists in the source, otherwise it waits for a decision
- a different translation of an existing term → waits for a decision
- a value you rejected once is not proposed again; locked terms never change
- with "review new terms" on, a new term is still added at once (the next chunks use it) and also waits for review; a source removed as "not a term" is ignored from then on (restore it at the bottom of the glossary)

In the "pause" decision mode a chapter stops at the chunk that proposed changes. Once they are decided it continues from there: the chunks already translated are kept, and the paused chunk is translated again only if a decision changed one of its terms (another translation or gender, or "not a term"). A decision made in the app or in one Telegram chat closes the buttons of the same question in every chat.

When you change a term, the app offers to translate again the chapters whose source mentions it.

**Export**: a zip of `.txt`, a zip of `.json` (the CLI's `{ content, title }` format) or one `.txt` with everything; the glossary exports and imports as JSON (the CLI's old flat `{"term": "переклад (чоловік)"}` files import too).

**Novel settings**: extra instructions for the prompt, fixed terms, reasoning effort, chunk size, cleanup strings/regexes and the validation thresholds (for a Latin-script target language set "Max Latin" to 100).

## Providers

| provider | default model | |
|---|---|---|
| OpenAI | `gpt-6-luna` | a base URL turns it into any OpenAI-compatible endpoint (OpenRouter, a local server) |
| Anthropic | `claude-opus-5-5` | the system prompt is marked for prompt caching; current Claude models reject `temperature` |
| Google | none, set the model | safety thresholds are set to `BLOCK_NONE`, otherwise fight scenes get chapters blocked |

`effort` maps to OpenAI `reasoningEffort` and Anthropic `effort`; translation rarely needs much, `low` is a good start.

## Development

```
packages/core   translation pipeline: chunking, prompts, validation, glossary rules (no I/O)
apps/web        Next.js app, Drizzle schema, pg-boss worker, Telegram bot
```

```sh
pnpm install
echo "DATABASE_URL=postgres://ranobe:ranobe@localhost:5432/ranobe
APP_SECRET=$(openssl rand -base64 32)" > apps/web/.env.local
pnpm --filter @ranobe-tl/web db:migrate
pnpm dev              # http://localhost:3000
pnpm dev:worker       # in a second terminal
pnpm test             # web tests that need Postgres run when DATABASE_URL is set
```

Releases: create a release with a new tag `v1.2.3` on GitHub (or just push the tag). CI builds the image for amd64 and arm64 (`:1.2.3`, `:1.2`, `:latest`) and attaches a `compose.yml` pinned to that version to the release (creating it if only the tag was pushed).

Schema changes: edit `apps/web/src/db/schema.ts`, then `pnpm --filter @ranobe-tl/web db:generate`.

The command-line version (`ranobe-tl` on npm, v0.1.x) lives on the [`cli`](https://github.com/VeiaG/ranobe-tl/tree/cli) branch.

## License

MIT
