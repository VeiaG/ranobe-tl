#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import chalk from "chalk";
import dotenv from "dotenv";
import { CONFIG_FILE, CONFIG_TEMPLATE, loadConfig } from "./config.js";
import { checkCommand, compactRanges } from "./commands/check.js";
import { lncrawlCommand } from "./commands/lncrawl.js";
import { GLOSSARY_HELP, glossaryCommand } from "./commands/glossary.js";
import { translateCommand } from "./commands/translate.js";
import { GlossaryStore } from "./glossary/store.js";

const HELP = `ranobe-tl <command> [options]

Run inside a novel folder (with ${CONFIG_FILE}) or pass --dir.

  init                         create ${CONFIG_FILE}
  lncrawl [title|id] [--force] [--lncrawl-dir D]
                               list novels downloaded by lightnovel-crawler (GUI),
                               or unpack one into ./chapters (creates ${CONFIG_FILE})
  translate [--from N] [--to N] [--only 1,5,10-12] [--force] [--retry-failed]
  check [--delete]             audit existing translations
  status                       chapters translated / failed / skipped
  glossary <sub>               see "ranobe-tl glossary help"

${GLOSSARY_HELP}`;

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            dir: { type: "string" },
            from: { type: "string" },
            to: { type: "string" },
            only: { type: "string" },
            force: { type: "boolean" },
            "retry-failed": { type: "boolean" },
            delete: { type: "boolean" },
            "lncrawl-dir": { type: "string" },
            all: { type: "boolean" },
            target: { type: "string" },
            gender: { type: "string" },
            type: { type: "string" },
            note: { type: "string" },
            help: { type: "boolean", short: "h" },
        },
    });
    const [command, ...args] = positionals;
    const root = path.resolve(values.dir ?? process.cwd());
    dotenv.config({ path: path.join(root, ".env"), quiet: true });
    dotenv.config({ quiet: true });
    const num = (v?: string) => (v === undefined ? undefined : parseInt(v, 10));

    switch (command) {
        case "init": {
            const file = path.join(root, CONFIG_FILE);
            try {
                await fs.access(file);
                console.log(chalk.yellow(`${CONFIG_FILE} already exists`));
            } catch {
                await fs.writeFile(file, JSON.stringify(CONFIG_TEMPLATE, null, 4) + "\n", "utf-8");
                console.log(chalk.green(`created ${file}`));
            }
            return;
        }
        case "translate":
            return translateCommand(await loadConfig(root), {
                from: num(values.from),
                to: num(values.to),
                only: values.only,
                force: values.force,
                retryFailed: values["retry-failed"],
            });
        case "lncrawl":
            return lncrawlCommand(root, args.join(" "), {
                lncrawlDir: values["lncrawl-dir"],
                force: values.force,
            });
        case "check":
            return checkCommand(await loadConfig(root), { delete: values.delete });
        case "status": {
            const config = await loadConfig(root);
            const store = new GlossaryStore(path.resolve(root, config.glossaryFile));
            const chapters = store.listChapters();
            for (const status of ["done", "failed", "skipped"] as const) {
                const list = chapters.filter((c) => c.status === status);
                console.log(`${status}: ${list.length}${list.length && status !== "done" ? `  ${compactRanges(list.map((c) => c.index))}` : ""}`);
                if (status !== "done") for (const c of list) console.log(chalk.dim(`  #${c.index}: ${c.error}`));
            }
            console.log(`pending glossary changes: ${store.listChanges("pending").length}`);
            store.close();
            return;
        }
        case "glossary":
            return glossaryCommand(await loadConfig(root), args, {
                target: values.target,
                gender: values.gender,
                type: values.type,
                note: values.note,
                from: num(values.from),
                all: values.all,
            });
        default:
            console.log(HELP);
    }
}

main().catch((error) => {
    console.error(chalk.red(error instanceof Error ? error.message : error));
    process.exit(1);
});
