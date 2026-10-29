# ranobe-tl

Self-hosted web app that translates web novels chapter by chapter with an LLM (OpenAI, Anthropic, Google or any OpenAI-compatible endpoint), keeping names and terms consistent through a glossary that grows as the translation goes.

![Dashboard](docs/dashboard.png)

- **strictly sequential per novel, parallel across novels**: terms found in chapter N are known in chapter N+1, and several novels translate at the same time
- **glossary per novel**: only terms that occur in the current chunk go into the prompt; gender is stored per chapter (`m@1 → f@840`)
- **every chunk is validated** and retried with feedback: length ratio, untranslated text, repetition loops, leaked tags / JSON, lost paragraphs (summarized passages), truncated output
- **the model reports new terms**; new ones are added on their own, changes to existing ones wait for you in **Decisions**
- **two ways to handle those changes**, per novel: keep translating and decide later, or stop that novel until you decide (others keep running) and translate the chapter again with the answer
- **optional review of new terms** (per novel, opt-in): every new name also lands in Decisions, where you confirm it, fix its translation, type or gender, or remove it as "not a term" so it is never proposed again; can be limited to some types and to the first N chapters
- **Telegram bot** with buttons for decisions, plus failures and finished runs; long polling, so it works behind NAT
- **sequels keep their names**: a new novel can start its glossary from another novel or a glossary file (this app's glossary.json, the CLI's meta.json or glossary.db); the last known gender holds from chapter 1, and rejected proposals and "not a term" sources come along. Terms can be added the same way to an existing novel; what it already has is kept
- **reader** with the original side by side and glossary terms highlighted, hand edits, re-translation of the chapters that use a changed term
- **translation history**: whenever a chapter's text is replaced (a new translation, an edit, a reset), the old one is kept (last 10); compare any version with the current text word by word and restore it
- **usage and costs**: every request is recorded (novel, chapter, key, model, tokens, whether validation rejected it); the Usage page shows daily spend by model, cost per chapter and what retries wasted, filtered by novel, provider, model or key. Costs come from an editable price table (Claude list prices built in), so the estimate before a run and the history stay in sync with it
- **budgets**: a total per novel and a monthly one per API key; a run pauses when it reaches either
- **instance settings** without restarts: how many novels translate at once, a limit per API key (rate limits, a local server), defaults for new novels, the Telegram bot token
- **backups as plain folders** in an S3-compatible bucket (R2, B2, MinIO, S3): translations, glossary and settings in the CLI's layout, uploaded incrementally; any folder (a backup, an export, an old CLI novel folder) imports back as a novel
- accounts: the first one is the admin, others join with invite links; API keys are stored encrypted

| | |
|---|---|
| ![Overview](docs/overview.png) | ![Reader](docs/reader.png) |
| ![Decisions](docs/decisions.png) | ![Glossary](docs/glossary.png) |

## Run it

Needs Docker. Works on a Raspberry Pi 4/5 (arm64): the model runs at the provider, the Pi only coordinates.

```sh
mkdir ranobe-tl && cd ranobe-tl
curl -O https://raw.githubusercontent.com/VeiaG/ranobe-tl/main/compose.yml
echo "APP_SECRET=$(openssl rand -base64 32)" > .env
docker compose up -d
```

Open http://localhost:3000, create the admin account, add an API key in **Settings → API keys**, create a novel and upload its chapters.

To build the image yourself instead of pulling it: clone the repo and run `docker compose up -d --build`.

### Configuration (`.env`)

| variable | | |
|---|---|---|
| `APP_SECRET` | required | encrypts API keys and signs sessions; keep it, keys can't be read without it |
| `APP_URL` | `http://localhost:3000` | public address: links in Telegram, auth cookies |
| `TELEGRAM_BOT_TOKEN` | | bot from @BotFather; can also be set in **Settings → Telegram** (that one wins), then link your chat there |
| `TELEGRAM_BOT_USERNAME` | | only if the web container can't reach api.telegram.org to look it up |
| `WORKER_CONCURRENCY` | 2 | novels translated at the same time, until changed in Settings → Instance |
| `WORKER_SLOTS` | 8 | the most a single worker can run at once; the real limit is the instance setting |
| `TRUSTED_ORIGINS` | | extra origins allowed to sign in, comma-separated (e.g. a second domain) |
| `BACKUP_CRON` | `17 3 * * *` | when the nightly backup check runs (see Backups) |
| `TZ` | UTC | time zone of `BACKUP_CRON` |
| `POSTGRES_PASSWORD`, `PORT` | | |

The image runs as `web`, `worker`, or `all` (both in one container, for the smallest setups). `compose.yml` runs `web` and `worker` separately; `docker compose stop` lets the chapter in flight finish (up to 10 minutes).

Migrations run on start.

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

**Glossary rules** (the same as the CLI had):
- new term → added (spelling variants of an existing term are not)
- gender unknown → m/f → applied retroactively
- gender m ↔ f → applied from this chapter if the model quotes evidence that really exists in the source, otherwise it waits for a decision
- a different translation of an existing term → waits for a decision
- a value you rejected once is not proposed again; locked terms never change
- with "review new terms" on, a new term is still added at once (the next chunks use it) and also waits for review; a source removed as "not a term" is ignored from then on (restore it at the bottom of the glossary)

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
cp .env.example apps/web/.env.local   # set DATABASE_URL and APP_SECRET
pnpm --filter @ranobe-tl/web db:migrate
pnpm dev              # http://localhost:3000
pnpm dev:worker       # in a second terminal
pnpm test             # web tests that need Postgres run when DATABASE_URL is set
```

Schema changes: edit `apps/web/src/db/schema.ts`, then `pnpm --filter @ranobe-tl/web db:generate`.

The command-line version (`ranobe-tl` on npm, v0.1.x) is at commit [`ae61c18`](https://github.com/VeiaG/ranobe-tl/tree/ae61c18).

## License

MIT
