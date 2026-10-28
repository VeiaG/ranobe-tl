import { generateText } from "ai";
import type { TranslationConfig } from "../config.js";
import type { Glossary, PendingOutcome, ProposalOutcome } from "../glossary/glossary.js";
import { checkSource, chunkText, cleanSource } from "./preprocess.js";
import { parseOutput } from "./parse.js";
import { systemPrompt, userPrompt } from "./prompt.js";
import { validateTranslation } from "./validate.js";
import type { ModelSetup } from "../providers.js";

export interface Usage {
    input: number;
    cachedInput: number;
    output: number;
}

export type ChapterResult =
    | { status: "done"; title: string; content: string; attempts: number; ratio: number; usage: Usage }
    | { status: "skipped"; reason: string }
    | { status: "failed"; attempts: number; reason: string; usage: Usage }
    /** A chunk proposed glossary changes and the handler asked to wait for a decision; nothing is saved. */
    | { status: "paused"; attempts: number; usage: Usage };

/**
 * What to do after a chunk proposed changes to existing terms:
 * - "retranslate": something was applied, translate the chunk again with the new glossary
 * - "continue": keep the chunk as is (the proposals stay queued)
 * - "pause": stop the chapter until a human decides
 */
export type PendingDecision = "retranslate" | "continue" | "pause";
export type PendingHandler = (pending: PendingOutcome[], chapter: number) => Promise<PendingDecision>;

export type TranslatorEvent =
    | { type: "chunk"; chapter: number; chunk: number; totalChunks: number }
    | { type: "attempt-failed"; chapter: number; chunk: number; attempt: number; reason: string }
    | { type: "latin-accepted"; chapter: number; chunk: number; attempt: number }
    | { type: "term"; chapter: number; outcome: ProposalOutcome }
    | { type: "retranslate"; chapter: number; chunk: number }
    | { type: "second-pass-failed"; chapter: number; chunk: number }
    /** Raw prompt and output of every request, for debugging. */
    | { type: "exchange"; chapter: number; chunk: number; attempt: number; system: string; prompt: string; output: string };

export interface TranslatorOptions {
    signal?: AbortSignal;
    onPending?: PendingHandler;
    onEvent?: (event: TranslatorEvent) => void | Promise<void>;
}

class PausedForDecisions extends Error {
    constructor(readonly attempts: number) {
        super("waiting for glossary decisions");
    }
}

export class Translator {
    /** Totals over the lifetime of this translator. */
    readonly usage: Usage = { input: 0, cachedInput: 0, output: 0 };
    private system: string;

    constructor(
        private config: TranslationConfig,
        private setup: ModelSetup,
        private glossary: Glossary,
        private opts: TranslatorOptions = {}
    ) {
        this.system = systemPrompt(config);
    }

    async translateChapter(index: number, rawSource: string): Promise<ChapterResult> {
        const source = cleanSource(rawSource, this.config);
        const check = checkSource(source, this.config);
        if (!check.ok) return { status: "skipped", reason: check.reason! };

        const usageBefore = { ...this.usage };
        const usage = () => ({
            input: this.usage.input - usageBefore.input,
            cachedInput: this.usage.cachedInput - usageBefore.cachedInput,
            output: this.usage.output - usageBefore.output,
        });

        const chunks = chunkText(source, this.config.chunkSize);
        const parts: string[] = [];
        let title: string | undefined;
        let attempts = 0;
        let translatedLength = 0;

        for (let c = 0; c < chunks.length; c++) {
            await this.emit({ type: "chunk", chapter: index, chunk: c, totalChunks: chunks.length });
            const previousContext = c > 0 ? parts[c - 1].slice(-this.config.contextChars) : undefined;
            let result: Awaited<ReturnType<Translator["translateChunk"]>>;
            try {
                result = await this.translateChunk(index, chunks[c], c, chunks.length, previousContext);
            } catch (error) {
                if (error instanceof PausedForDecisions) {
                    return { status: "paused", attempts: attempts + error.attempts, usage: usage() };
                }
                throw error;
            }
            attempts += result.attempts;
            if (!result.ok) {
                return { status: "failed", attempts, reason: `chunk ${c + 1}/${chunks.length}: ${result.reason}`, usage: usage() };
            }
            if (c === 0) title = result.title;
            parts.push(result.translation);
            translatedLength += result.translation.length;
        }

        return {
            status: "done",
            title: title?.trim() || source.split("\n")[0].trim(),
            content: parts.join("\n\n"),
            attempts,
            ratio: translatedLength / source.length,
            usage: usage(),
        };
    }

    private async translateChunk(
        chapter: number,
        text: string,
        chunk: number,
        totalChunks: number,
        previousContext?: string,
        ask = true
    ): Promise<{ ok: true; translation: string; title?: string; attempts: number } | { ok: false; reason: string; attempts: number }> {
        let feedback: string | undefined;
        let lastReason = "";
        // Latin share of the previous attempt when that was its only problem.
        let previousLatin: number | undefined;

        for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
            const terms = this.glossary.relevant(text);
            const prompt = userPrompt({ text, terms, chapter, chunk, totalChunks, previousContext, feedback });

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
                    abortSignal: this.opts.signal,
                });
                this.addUsage(res.usage);
                output = res.text;
                if (res.finishReason === "length") lastReason = "output hit the token limit";
                if (res.finishReason === "content-filter") lastReason = "blocked by the content filter";
            } catch (error) {
                // A user abort must stop the chapter, not count as a failed attempt.
                if (this.opts.signal?.aborted) throw error;
                lastReason = `request failed: ${error instanceof Error ? error.message : String(error)}`;
                await this.emit({ type: "exchange", chapter, chunk, attempt, system: this.system, prompt, output: String(error) });
                await this.emit({ type: "attempt-failed", chapter, chunk, attempt, reason: lastReason });
                continue;
            }
            await this.emit({ type: "exchange", chapter, chunk, attempt, system: this.system, prompt, output });

            const parsed = parseOutput(output);
            const validation = validateTranslation(text, parsed.translation, this.config, parsed.problems);
            if (!validation.ok) {
                lastReason = validation.problems.join("; ");
                await this.emit({ type: "attempt-failed", chapter, chunk, attempt, reason: lastReason });
                // The same amount of Latin twice in a row means the text really has it
                // (names, game terms, English inserts): another retry will not change it.
                if (validation.latinOnly && previousLatin !== undefined && latinStable(previousLatin, validation.latinPercent)) {
                    await this.emit({ type: "latin-accepted", chapter, chunk, attempt });
                } else {
                    previousLatin = validation.latinOnly ? validation.latinPercent : undefined;
                    feedback = lastReason;
                    continue;
                }
            }

            const pending = await this.applyTerms(parsed.terms, chapter, text);
            const result = { ok: true as const, translation: parsed.translation, title: parsed.title, attempts: attempt };
            if (!ask || !pending.length || !this.opts.onPending) return result;

            // The model writes the current glossary translation into the text and only proposes the new one,
            // so an accepted change needs one more pass. All changes of the chunk are decided first.
            const decision = await this.opts.onPending(pending, chapter);
            if (decision === "pause") throw new PausedForDecisions(attempt);
            if (decision === "continue") return result;

            for (const o of pending) await this.glossary.reload(o.term.id);
            await this.emit({ type: "retranslate", chapter, chunk });
            const again = await this.translateChunk(chapter, text, chunk, totalChunks, previousContext, false);
            if (again.ok) return { ...again, attempts: attempt + again.attempts };
            await this.emit({ type: "second-pass-failed", chapter, chunk });
            return { ...result, attempts: attempt + again.attempts };
        }
        return { ok: false, reason: lastReason, attempts: this.config.maxAttempts };
    }

    /** Applies the proposed terms and returns the changes that wait for a decision. */
    private async applyTerms(terms: ReturnType<typeof parseOutput>["terms"], chapter: number, sourceText: string): Promise<PendingOutcome[]> {
        const pending: PendingOutcome[] = [];
        for (const p of terms) {
            for (const outcome of await this.glossary.propose(p, chapter, sourceText)) {
                await this.emit({ type: "term", chapter, outcome });
                if (outcome.kind === "pending") pending.push(outcome);
            }
        }
        return pending;
    }

    private addUsage(u: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } }) {
        this.usage.input += u.inputTokens ?? 0;
        this.usage.output += u.outputTokens ?? 0;
        this.usage.cachedInput += u.inputTokenDetails?.cacheReadTokens ?? 0;
    }

    private async emit(event: TranslatorEvent) {
        await this.opts.onEvent?.(event);
    }
}

/** Two Latin shares are "about the same": within half a percentage point or 15% of each other. */
function latinStable(previous: number, current: number): boolean {
    return Math.abs(previous - current) <= Math.max(0.5, previous * 0.15);
}

export type EventLevel = "info" | "success" | "warning" | "error";

/** One-line description of a translator event for logs; undefined for events not worth showing. */
export function describeEvent(e: TranslatorEvent): { level: EventLevel; message: string } | undefined {
    const where = (chunk: number, attempt?: number) => `chunk ${chunk + 1}${attempt ? `, attempt ${attempt}` : ""}`;
    switch (e.type) {
        case "attempt-failed":
            return { level: "warning", message: `${where(e.chunk, e.attempt)}: ${e.reason}` };
        case "latin-accepted":
            return { level: "info", message: `${where(e.chunk, e.attempt)}: accepted, the Latin share is stable across attempts` };
        case "retranslate":
            return { level: "info", message: `${where(e.chunk)}: translating again with the updated glossary` };
        case "second-pass-failed":
            return { level: "warning", message: `${where(e.chunk)}: the second pass failed, keeping the first one` };
        case "term":
            return describeOutcome(e.outcome);
        default:
            return undefined;
    }
}

function describeOutcome(o: ProposalOutcome): { level: EventLevel; message: string } | undefined {
    switch (o.kind) {
        case "added": {
            const like = o.lookalikes.length ? ` (looks like: ${o.lookalikes.map((t) => `${t.source} → ${t.target}`).join(", ")})` : "";
            return { level: "success", message: `new term: ${o.term.source} → ${o.term.target} [${o.term.type}]${like}` };
        }
        case "gender-resolved":
            return { level: "info", message: `${o.term.source}: gender → ${o.gender}` };
        case "gender-changed":
            return { level: "info", message: `${o.term.source}: gender ${o.from} → ${o.to} (evidence verified)` };
        case "pending":
            return { level: "warning", message: `${o.term.source}: ${o.field} "${o.value}" waits for a decision (${o.why})` };
        case "rejected":
            return { level: "info", message: `${o.term.source}: ${o.field} "${o.value}" rejected (${o.why})` };
        case "similar":
            return { level: "info", message: `${o.proposed.source} not added, similar to: ${o.similar.map((t) => t.source).join(", ")}` };
        default:
            return undefined;
    }
}
