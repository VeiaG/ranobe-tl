# ranobe-tl

Self-hosted web app that translates web novels chapter by chapter with an LLM (OpenAI, Anthropic, Google or any OpenAI-compatible endpoint), keeping names and terms consistent through a glossary that grows as the translation goes.

![Dashboard](docs/dashboard.png)

- **strictly sequential per novel, parallel across novels**: terms found in chapter N are known in chapter N+1, and several novels translate at the same time
- **glossary per novel**: only terms that occur in the current chunk go into the prompt; gender is stored per chapter (`m@1 → f@840`)
- **every chunk is validated** and retried with feedback: length ratio, untranslated text, repetition loops, leaked tags / JSON, lost paragraphs (summarized passages), truncated output
- **the model reports new terms**; new ones are added on their own, changes to existing ones wait for you in **Decisions**
- **two ways to handle those changes**, per novel: keep translating and decide later, or stop that novel until you decide (others keep running) and translate the chapter again with the answer
- **Telegram bot** with buttons for decisions, plus failures and finished runs; long polling, so it works behind NAT
- **reader** with the original side by side and glossary terms highlighted, hand edits, re-translation of the chapters that use a changed term
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
| `TELEGRAM_BOT_TOKEN` | | bot from @BotFather; link your chat in **Settings → Telegram** |
| `TELEGRAM_BOT_USERNAME` | | only if the web container can't reach api.telegram.org to look it up |
| `WORKER_CONCURRENCY` | 2 | novels translated at the same time |
| `TRUSTED_ORIGINS` | | extra origins allowed to sign in, comma-separated (e.g. a second domain) |
| `POSTGRES_PASSWORD`, `PORT` | | |

The image runs as `web`, `worker`, or `all` (both in one container, for the smallest setups). `compose.yml` runs `web` and `worker` separately; `docker compose stop` lets the chapter in flight finish (up to 10 minutes).

Migrations run on start. Back up the `db` volume (`docker compose exec db pg_dump -U ranobe ranobe > backup.sql`).

## Using it

**Chapters**: upload `.txt` files (first line is the title, the number comes from the file name: `00012.txt`, `Chapter 12.txt`), a `.zip` of them, a JSON array (`[{ "index", "title", "content" }]`), or paste a long text and split it at "Chapter N" lines.

**Translate** queues everything not translated yet, failed chapters, or a range (optionally translating done chapters again). **Pause** lets the chapter in flight finish; **Stop now** drops it. After 3 failed chapters in a row (a bad key, a dead endpoint) the run pauses itself.

**Glossary rules** (the same as the CLI had):
- new term → added (spelling variants of an existing term are not)
- gender unknown → m/f → applied retroactively
- gender m ↔ f → applied from this chapter if the model quotes evidence that really exists in the source, otherwise it waits for a decision
- a different translation of an existing term → waits for a decision
- a value you rejected once is not proposed again; locked terms never change

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
