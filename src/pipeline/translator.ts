import { promises as fs } from "node:fs";
import path from "node:path";
import chalk from "chalk";
import { generateText } from "ai";
import { chapterFile, type Config } from "../config.js";
import type { Glossary, ProposalOutcome } from "../glossary/glossary.js";
import type { GlossaryStore } from "../glossary/store.js";
import { checkSource, chunkText, cleanSource } from "./preprocess.js";
import { parseOutput } from "./parse.js";
import { systemPrompt, userPrompt } from "./prompt.js";
import { validateTranslation } from "./validate.js";
import { resolveModelId, type ModelSetup } from "../providers.js";

export interface Usage {
    input: number;
    cachedInput: number;
    output: number;
}

export type ChapterResult =
    | { status: "done"; attempts: number; ratio: number }
    | { status: "exists" }
    | { status: "skipped"; reason: string }
    | { status: "failed"; attempts: number; reason: string };

export class Translator {
    readonly usage: Usage = { input: 0, cachedInput: 0, output: 0 };
    private system: string;

    constructor(
        private config: Config,
        private setup: ModelSetup,
        private glossary: Glossary,
        private store: GlossaryStore,
        private signal?: AbortSignal
    ) {
        this.system = systemPrompt(config);
    }

    async translateChapter(index: number, force = false): Promise<ChapterResult> {
        const outFile = chapterFile(this.config, "output", index);
        if (!force && (await hasTranslation(outFile))) return { status: "exists" };

        const raw = await fs.readFile(chapterFile(this.config, "input", index), "utf-8");
        const source = cleanSource(raw, this.config);
        const check = checkSource(source, this.config);
        if (!check.ok) {
            this.record(index, "skipped", 0, null, check.reason!);
            return { status: "skipped", reason: check.reason! };
        }

        const chunks = chunkText(source, this.config.chunkSize);
        const parts: string[] = [];
        let title: string | undefined;
        let attempts = 0;
        let translatedLength = 0;

        for (let c = 0; c < chunks.length; c++) {
            const previousContext = c > 0 ? parts[c - 1].slice(-this.config.contextChars) : undefined;
            const result = await this.translateChunk(index, chunks[c], c, chunks.length, previousContext);
            attempts += result.attempts;
            if (!result.ok) {
                const reason = `chunk ${c + 1}/${chunks.length}: ${result.reason}`;
                this.record(index, "failed", attempts, null, reason);
                return { status: "failed", attempts, reason };
            }
            if (c === 0) title = result.title;
            parts.push(result.translation);
            translatedLength += result.translation.length;
        }

        const content = parts.join("\n\n");
        const finalTitle = title?.trim() || source.split("\n")[0].trim();
        await fs.mkdir(path.dirname(outFile), { recursive: true });
        await fs.writeFile(outFile, JSON.stringify({ content, title: finalTitle }, null, 2), "utf-8");

        const ratio = translatedLength / source.length;
        this.record(index, "done", attempts, ratio, "");
        return { status: "done", attempts, ratio };
    }

    private async translateChunk(
        chapter: number,
        text: string,
        chunk: number,
        totalChunks: number,
        previousContext?: string
    ): Promise<{ ok: true; translation: string; title?: string; attempts: number } | { ok: false; reason: string; attempts: number }> {
        let feedback: string | undefined;
        let lastReason = "";

        for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
            const terms = this.glossary.relevant(text);
            const prompt = userPrompt({ text, terms, chapter, chunk, totalChunks, previousContext, feedback });
            const label = `#${chapter}${totalChunks > 1 ? ` [${chunk + 1}/${totalChunks}]` : ""} attempt ${attempt}`;

            let output: string;
            try {
                const res = await generateText({
                    model: this.setup.model,
                    system: { role: "system", content: this.system, providerOptions: this.setup.systemProviderOptions },
                    prompt,
                    providerOptions: this.setup.providerOptions,
                    maxOutputTokens: this.config.maxOutputTokens,
                    temperature: this.config.temperature,
                    maxRetries: 5,
                    abortSignal: this.signal,
                });
                this.addUsage(res.usage);
                output = res.text;
                if (res.finishReason === "length") lastReason = "output hit the token limit";
                if (res.finishReason === "content-filter") lastReason = "blocked by the content filter";
            } catch (error) {
                // A user abort must stop the chapter, not count as a failed attempt.
                if (this.signal?.aborted) throw error;
                lastReason = `request failed: ${error instanceof Error ? error.message : String(error)}`;
                console.log(chalk.yellow(`  ⚠ ${label}: ${lastReason}`));
                await this.debug(chapter, chunk, attempt, prompt, String(error));
                continue;
            }
            await this.debug(chapter, chunk, attempt, prompt, output);

            const parsed = parseOutput(output);
            const validation = validateTranslation(text, parsed.translation, this.config, parsed.problems);
            if (!validation.ok) {
                lastReason = validation.problems.join("; ");
                feedback = lastReason;
                console.log(chalk.yellow(`  ⚠ ${label}: ${lastReason}`));
                continue;
            }

            this.applyTerms(parsed.terms, chapter, text);
            return { ok: true, translation: parsed.translation, title: parsed.title, attempts: attempt };
        }
        return { ok: false, reason: lastReason, attempts: this.config.maxAttempts };
    }

    private applyTerms(terms: ReturnType<typeof parseOutput>["terms"], chapter: number, sourceText: string): void {
        this.store.transaction(() => {
            for (const p of terms) {
                for (const outcome of this.glossary.propose(p, chapter, sourceText)) logOutcome(outcome);
            }
        });
    }

    private record(index: number, status: "done" | "failed" | "skipped", attempts: number, ratio: number | null, error: string) {
        this.store.saveChapter({ index, status, model: resolveModelId(this.config), attempts, ratio, error });
    }

    private addUsage(u: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } }) {
        this.usage.input += u.inputTokens ?? 0;
        this.usage.output += u.outputTokens ?? 0;
        this.usage.cachedInput += u.inputTokenDetails?.cacheReadTokens ?? 0;
    }

    private async debug(chapter: number, chunk: number, attempt: number, prompt: string, output: string) {
        if (!this.config.debug.savePrompts) return;
        const dir = path.join(this.config.root, this.config.debug.folder);
        await fs.mkdir(dir, { recursive: true });
        const base = path.join(dir, `${chapter}_${chunk + 1}_${attempt}`);
        await fs.writeFile(`${base}_prompt.txt`, `${this.system}\n\n===== USER =====\n\n${prompt}`, "utf-8");
        await fs.writeFile(`${base}_output.txt`, output, "utf-8");
    }
}

async function hasTranslation(file: string): Promise<boolean> {
    try {
        const json = JSON.parse(await fs.readFile(file, "utf-8"));
        return typeof json.content === "string" && json.content.length > 0;
    } catch {
        return false;
    }
}

function logOutcome(o: ProposalOutcome): void {
    switch (o.kind) {
        case "added":
            console.log(chalk.green(`  + ${o.term.source} → ${o.term.target}`) + chalk.dim(` [${o.term.type}]`));
            if (o.lookalikes.length) {
                console.log(chalk.yellow(`    looks like: ${o.lookalikes.map((t) => `${t.source} → ${t.target}`).join(", ")}`));
            }
            break;
        case "gender-resolved":
            console.log(chalk.cyan(`  ⚥ ${o.term.source}: gender → ${o.gender}`));
            break;
        case "gender-changed":
            console.log(chalk.magenta(`  ⚥ ${o.term.source}: gender ${o.from} → ${o.to} (evidence verified)`));
            break;
        case "pending":
            console.log(chalk.yellow(`  ? ${o.term.source}: ${o.field} "${o.value}" queued for review (${o.why})`));
            break;
        case "rejected":
            console.log(chalk.dim(`  ✗ ${o.term.source}: ${o.field} "${o.value}" rejected (${o.why})`));
            break;
        case "similar":
            console.log(
                chalk.yellow(`  ~ ${o.proposed.source} not added, similar to: ${o.similar.map((t) => t.source).join(", ")}`)
            );
            break;
    }
}
