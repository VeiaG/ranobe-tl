import { and, eq, sql } from "drizzle-orm";
import { generateText } from "ai";
import { Glossary, batchSystemPrompt, batchUserPrompt, createModel, wellFormed } from "@ranobe-tl/core";
import type { DB } from "@/db";
import { chapter, novel, usageRecord } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { logEvent } from "@/server/activity";
import { budgetStop } from "@/server/budget";
import { PgGlossaryStore } from "@/server/glossary-store";
import { requestSync } from "@/server/queue";
import { checkChunk, completeChapter, finishIfIdle, type BatchNotifier } from "./ingest";
import { batchSetup } from "./submit";

/**
 * Translates one chapter of a batch novel with ordinary requests instead of a batch: the same prompts and
 * validation, full price, done in minutes. For a few chapters (failed ones, a re-translation) a batch is not worth the wait.
 */
export async function translateDirect(db: DB, chapterId: number, notifier: BatchNotifier): Promise<void> {
    const [ch] = await db.select().from(chapter).where(eq(chapter.id, chapterId));
    // canceled or sent elsewhere meanwhile
    if (!ch || ch.status !== "translating" || !ch.batchState) return;
    const [n] = await db.select().from(novel).where(eq(novel.id, ch.novelId));
    if (!n) return;
    const state = ch.batchState;

    const fail = async (reason: string) => {
        await db
            .update(chapter)
            .set({ status: "failed", error: reason, batchState: null, attempts: state.attempts.reduce((a, b) => a + b, 0) })
            .where(and(eq(chapter.id, ch.id), eq(chapter.status, "translating")));
        await logEvent(db, n.id, "error", `chapter ${ch.index} failed: ${reason}`, ch.index);
        await notifier.chapterFailed(n, ch.index, reason).catch((error) => console.error("[batch] notification failed:", error));
        await finishIfIdle(db, n, notifier);
    };

    let setup;
    try {
        setup = await batchSetup(db, n);
    } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
    const { config, model, key } = setup;
    const overBudget = await budgetStop(db, n, key);
    if (overBudget) return fail(overBudget);
    const ai = createModel(config, decrypt(key.encryptedKey));
    const glossary = await Glossary.load(new PgGlossaryStore(db, n.id), { fixedTerms: config.fixedTerms });
    const system = wellFormed(batchSystemPrompt(config));

    for (let c = 0; c < state.sources.length; c++) {
        while (state.parts[c] === null) {
            // canceled or reset meanwhile: stop spending
            const [now] = await db.select({ status: chapter.status }).from(chapter).where(eq(chapter.id, ch.id));
            if (now?.status !== "translating") return finishIfIdle(db, n, notifier);
            if (state.attempts[c] >= config.maxAttempts) return fail(`chunk ${c + 1}/${state.sources.length}: ${state.feedback[c] ?? "no usable reply"}`);
            const attempt = ++state.attempts[c];
            const text = state.sources[c];
            const prompt = batchUserPrompt({
                text,
                terms: glossary.relevant(text),
                chapter: ch.index,
                chunk: c,
                totalChunks: state.sources.length,
                sourceContext: c > 0 && config.contextChars > 0 ? state.sources[c - 1].slice(-config.contextChars) : undefined,
                feedback: state.feedback[c] ?? undefined,
            });
            let output: string;
            let usage: { inputTokens?: number; outputTokens?: number; inputTokenDetails?: { cacheReadTokens?: number } };
            let stop: string | undefined;
            try {
                const res = await generateText({
                    model: ai.model,
                    system: { role: "system", content: system, providerOptions: ai.systemProviderOptions },
                    prompt: wellFormed(prompt),
                    providerOptions: ai.providerOptions,
                    maxOutputTokens: config.maxOutputTokens,
                    maxRetries: 5,
                });
                output = res.text;
                usage = res.usage;
                if (res.finishReason === "length") stop = "output hit the token limit";
                if (res.finishReason === "content-filter") stop = "blocked by the content filter";
            } catch (error) {
                state.feedback[c] = null;
                await logEvent(db, n.id, "warning", `chunk ${c + 1}, attempt ${attempt}: request failed: ${error instanceof Error ? error.message : String(error)}`, ch.index);
                continue;
            }
            const accepted = await checkChunk(db, n.id, ch.index, state, c, attempt, output, stop, config);
            const tokens = { input: usage.inputTokens ?? 0, cached: usage.inputTokenDetails?.cacheReadTokens ?? 0, output: usage.outputTokens ?? 0 };
            await db.insert(usageRecord).values({
                novelId: n.id,
                novelTitle: n.title,
                chapter: ch.index,
                chunk: c,
                attempt,
                keyId: key.id,
                provider: key.provider,
                model,
                inputTokens: tokens.input,
                cachedTokens: tokens.cached,
                outputTokens: tokens.output,
                ok: accepted,
            });
            await db
                .update(chapter)
                .set({
                    inputTokens: sql`${chapter.inputTokens} + ${tokens.input}`,
                    cachedTokens: sql`${chapter.cachedTokens} + ${tokens.cached}`,
                    outputTokens: sql`${chapter.outputTokens} + ${tokens.output}`,
                    batchState: state,
                })
                .where(eq(chapter.id, ch.id));
            await db
                .update(novel)
                .set({
                    inputTokens: sql`${novel.inputTokens} + ${tokens.input}`,
                    cachedTokens: sql`${novel.cachedTokens} + ${tokens.cached}`,
                    outputTokens: sql`${novel.outputTokens} + ${tokens.output}`,
                })
                .where(eq(novel.id, n.id));
        }
    }

    // the token counts were added as the requests went
    const [fresh] = await db.select().from(chapter).where(eq(chapter.id, ch.id));
    await completeChapter(db, fresh, state, model);
    await logEvent(db, n.id, "success", `chapter ${ch.index} translated right away (${state.attempts.reduce((a, b) => a + b, 0)} requests)`, ch.index);
    await requestSync(n.id, "worker");
    await finishIfIdle(db, n, notifier);
}
