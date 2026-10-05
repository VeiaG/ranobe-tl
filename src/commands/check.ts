import { promises as fs } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { chapterFile, type Config } from "../config.js";
import { GlossaryStore } from "../glossary/store.js";
import { checkSource, cleanSource } from "../pipeline/preprocess.js";
import { validateTranslation } from "../pipeline/validate.js";

/** Audits existing translations with the same rules the translator uses. */
export async function checkCommand(config: Config, opts: { delete?: boolean }): Promise<void> {
    const problems = new Map<number, string[]>();
    const missing: number[] = [];
    let checked = 0;

    for (let i = config.range.start; i <= config.range.end; i++) {
        let source: string;
        try {
            source = cleanSource(await fs.readFile(chapterFile(config, "input", i), "utf-8"), config);
        } catch {
            continue;
        }
        const sourceCheck = checkSource(source, config);
        let output: { content?: string; title?: string };
        try {
            output = JSON.parse(await fs.readFile(chapterFile(config, "output", i), "utf-8"));
        } catch {
            if (sourceCheck.ok) missing.push(i);
            continue;
        }
        checked++;
        const list: string[] = [];
        if (!sourceCheck.ok) list.push(`bad source: ${sourceCheck.reason}`);
        const v = validateTranslation(source, output.content ?? "", config);
        list.push(...v.problems.map((p) => p.split(":")[0]));
        const title = output.title ?? "";
        if (title.length < 3 || title.length > 120 || /[{}<>`]/.test(title)) list.push(`suspicious title "${title.slice(0, 60)}"`);
        if (list.length) problems.set(i, list);
    }

    for (const [i, list] of problems) {
        console.log(chalk.yellow(`#${i}: `) + list.join("; "));
    }
    console.log(chalk.cyan(`\n${checked} translations checked, ${problems.size} with problems, ${missing.length} missing`));
    if (problems.size) console.log(`problems: ${[...problems.keys()].join(",")}`);
    if (missing.length) console.log(`missing: ${compactRanges(missing)}`);

    if (opts.delete && problems.size) {
        const store = new GlossaryStore(path.resolve(config.root, config.glossaryFile));
        for (const [i, list] of problems) {
            await fs.unlink(chapterFile(config, "output", i));
            store.saveChapter({ index: i, status: "failed", model: "", attempts: 0, ratio: null, error: `check: ${list.join("; ")}` });
        }
        store.close();
        console.log(chalk.red(`deleted ${problems.size} translations (marked as failed, use translate --retry-failed)`));
    }
}

export function compactRanges(nums: number[]): string {
    const out: string[] = [];
    for (let i = 0; i < nums.length; i++) {
        let j = i;
        while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
        out.push(i === j ? `${nums[i]}` : `${nums[i]}-${nums[j]}`);
        i = j;
    }
    return out.join(",");
}
