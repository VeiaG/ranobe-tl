import path from "node:path";
import chalk from "chalk";
import type { Config } from "../config.js";
import { Glossary } from "../glossary/glossary.js";
import { GlossaryStore } from "../glossary/store.js";
import { Translator } from "../pipeline/translator.js";
import { createModel } from "../providers.js";

export function parseIndexList(spec: string): number[] {
    return spec.split(",").flatMap((part) => {
        const [a, b] = part.split("-").map((s) => parseInt(s.trim(), 10));
        if (Number.isNaN(a)) return [];
        if (b === undefined || Number.isNaN(b)) return [a];
        return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    });
}

export async function translateCommand(
    config: Config,
    opts: { from?: number; to?: number; only?: string; force?: boolean; retryFailed?: boolean }
): Promise<void> {
    const store = new GlossaryStore(path.resolve(config.root, config.glossaryFile));
    const glossary = new Glossary(store, config.fixedTerms);
    const translator = new Translator(config, createModel(config), glossary, store);

    let indexes: number[];
    if (opts.only) indexes = parseIndexList(opts.only);
    else if (opts.retryFailed) indexes = store.listChapters("failed").map((c) => c.index);
    else {
        const from = opts.from ?? config.range.start;
        const to = opts.to ?? config.range.end;
        indexes = Array.from({ length: to - from + 1 }, (_, i) => from + i);
    }
    const force = opts.force || opts.retryFailed;

    console.log(chalk.cyan(`${config.provider}/${config.model} · ${glossary.size} glossary terms · ${indexes.length} chapters`));

    let interrupted = false;
    process.on("SIGINT", () => {
        if (interrupted) process.exit(130);
        interrupted = true;
        console.log(chalk.yellow("\nStopping after the current chapter (Ctrl+C again to abort)..."));
    });

    const counts = { done: 0, exists: 0, skipped: 0, failed: 0 };
    const started = Date.now();

    for (const index of indexes) {
        if (interrupted) break;
        const t0 = Date.now();
        console.log(chalk.bold(`\n▶ Chapter ${index}`));
        try {
            const res = await translator.translateChapter(index, force);
            counts[res.status]++;
            const secs = ((Date.now() - t0) / 1000).toFixed(0);
            if (res.status === "done") console.log(chalk.green(`✔ done in ${secs}s, ratio ${res.ratio.toFixed(2)}, attempts ${res.attempts}`));
            else if (res.status === "exists") console.log(chalk.dim("  already translated"));
            else if (res.status === "skipped") console.log(chalk.yellow(`⏭ skipped: ${res.reason}`));
            else console.log(chalk.red(`✘ failed: ${res.reason}`));
        } catch (error) {
            counts.failed++;
            console.log(chalk.red(`✘ error: ${error instanceof Error ? error.message : error}`));
            store.saveChapter({ index, status: "failed", model: config.model, attempts: 0, ratio: null, error: String(error) });
        }
    }

    const minutes = ((Date.now() - started) / 60000).toFixed(1);
    const u = translator.usage;
    console.log(chalk.cyan(`\n${counts.done} translated, ${counts.exists} existed, ${counts.skipped} skipped, ${counts.failed} failed in ${minutes} min`));
    console.log(chalk.dim(`tokens: ${u.input} in (${u.cachedInput} cached), ${u.output} out`));
    const pending = store.listChanges("pending").length;
    if (pending) console.log(chalk.yellow(`${pending} glossary changes wait for review: ranobe-tl glossary changes`));
    store.close();
}
