import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { Glossary, createModel, describeEvent, resolveModelId, type PendingHandler, type TranslatorEvent } from "@ranobe-tl/core";
import { Translator } from "@ranobe-tl/core";
import type { DB } from "@/db";
import { chapter, exchange, novel, providerKey, termChange } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { logEvent } from "@/server/activity";
import { PgGlossaryStore } from "@/server/glossary-store";
import { novelConfig } from "@/server/novel-config";
import type { Notifier } from "./notify";

/** After this many failed chapters in a row the run pauses itself: usually a bad key or a dead endpoint. */
const MAX_FAIL_STREAK = 3;
/** How often the run checks whether the user asked to stop the chapter in flight. */
const STOP_POLL_MS = 2000;

export type StepOutcome = "next" | "stop";

/**
 * Translates the next queued chapter of a novel. Returns "next" when the novel should go on
 * (the caller queues the following job), "stop" when it finished, paused or failed.
 */
export async function translateNext(db: DB, novelId: number, notifier: Notifier): Promise<StepOutcome> {
    const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
    if (!n || n.status !== "running") return "stop";

    const [ch] = await db
        .select()
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), inArray(chapter.status, ["translating", "queued"])))
        .orderBy(asc(chapter.index))
        .limit(1);
    if (!ch) {
        await db.update(novel).set({ status: "idle", statusMessage: "", failStreak: 0 }).where(eq(novel.id, novelId));
        await logEvent(db, novelId, "success", "run finished: no queued chapters left");
        await notifier.finished(n);
        return "stop";
    }

    const key = n.providerKeyId ? (await db.select().from(providerKey).where(eq(providerKey.id, n.providerKeyId)))[0] : undefined;
    if (!key) return halt(db, n, notifier, "no API key selected for this novel");

    let config;
    let setup;
    try {
        config = novelConfig(n, key);
        setup = createModel(config, decrypt(key.encryptedKey));
    } catch (error) {
        return halt(db, n, notifier, error instanceof Error ? error.message : String(error));
    }
    const model = resolveModelId(config);

    await db.update(chapter).set({ status: "translating", error: "" }).where(eq(chapter.id, ch.id));
    await db.update(novel).set({ statusMessage: `Translating chapter ${ch.index}` }).where(eq(novel.id, novelId));
    await db.delete(exchange).where(and(eq(exchange.novelId, novelId), eq(exchange.chapter, ch.index)));

    // Proposals created before this chapter started do not stop it again (e.g. after "resume anyway").
    const [{ lastChange }] = await db
        .select({ lastChange: sql<number>`coalesce(max(${termChange.id}), 0)` })
        .from(termChange)
        .where(eq(termChange.novelId, novelId));

    const store = new PgGlossaryStore(db, novelId);
    const glossary = await Glossary.load(store, config.fixedTerms);

    const abort = new AbortController();
    const poll = setInterval(async () => {
        try {
            const [s] = await db.select({ stop: novel.stopRequested, status: novel.status }).from(novel).where(eq(novel.id, novelId));
            if (!s || s.stop) abort.abort(new Error("stopped by the user"));
        } catch {
            // a missed poll is fine, the next one will try again
        }
    }, STOP_POLL_MS);

    const onPending: PendingHandler | undefined =
        n.decisionMode === "pause"
            ? async (pending) => {
                  const ids = [...new Set(pending.map((o) => o.term.id))];
                  const fresh = await db
                      .select({ id: termChange.id })
                      .from(termChange)
                      .where(
                          and(
                              eq(termChange.novelId, novelId),
                              eq(termChange.status, "pending"),
                              inArray(termChange.termId, ids),
                              gt(termChange.id, Number(lastChange))
                          )
                      )
                      .limit(1);
                  return fresh.length ? "pause" : "continue";
              }
            : undefined;

    const onEvent = async (e: TranslatorEvent) => {
        if (e.type === "exchange") {
            await db.insert(exchange).values({
                novelId,
                chapter: e.chapter,
                chunk: e.chunk,
                attempt: e.attempt,
                prompt: e.prompt,
                output: e.output,
            });
            return;
        }
        if (e.type === "chunk" && e.totalChunks > 1) {
            await db
                .update(novel)
                .set({ statusMessage: `Translating chapter ${ch.index} · part ${e.chunk + 1} of ${e.totalChunks}` })
                .where(eq(novel.id, novelId));
            return;
        }
        const d = describeEvent(e);
        if (d) await logEvent(db, novelId, d.level, d.message, e.chapter);
    };

    const translator = new Translator(config, setup, glossary, { signal: abort.signal, onPending, onEvent });
    const started = Date.now();
    let result;
    try {
        result = await translator.translateChapter(ch.index, ch.source);
    } catch (error) {
        clearInterval(poll);
        if (abort.signal.aborted) {
            await db.update(chapter).set({ status: "queued" }).where(eq(chapter.id, ch.id));
            await db
                .update(novel)
                .set({ status: "paused", statusMessage: "", stopRequested: false })
                .where(eq(novel.id, novelId));
            await logEvent(db, novelId, "warning", `stopped while translating chapter ${ch.index}; nothing was saved for it`, ch.index);
            return "stop";
        }
        const message = error instanceof Error ? error.message : String(error);
        await db.update(chapter).set({ status: "failed", error: message, model }).where(eq(chapter.id, ch.id));
        return halt(db, n, notifier, `chapter ${ch.index}: ${message}`);
    } finally {
        clearInterval(poll);
    }

    const duration = Math.round((Date.now() - started) / 1000);
    const usage = "usage" in result ? result.usage : { input: 0, cachedInput: 0, output: 0 };
    await db
        .update(novel)
        .set({
            inputTokens: sql`${novel.inputTokens} + ${usage.input}`,
            cachedTokens: sql`${novel.cachedTokens} + ${usage.cachedInput}`,
            outputTokens: sql`${novel.outputTokens} + ${usage.output}`,
        })
        .where(eq(novel.id, novelId));
    const tokens = {
        inputTokens: usage.input,
        cachedTokens: usage.cachedInput,
        outputTokens: usage.output,
    };

    switch (result.status) {
        case "done":
            await db
                .update(chapter)
                .set({
                    status: "done",
                    title: result.title,
                    content: result.content,
                    attempts: result.attempts,
                    ratio: result.ratio,
                    error: "",
                    model,
                    duration,
                    translatedAt: new Date(),
                    ...tokens,
                })
                .where(eq(chapter.id, ch.id));
            await db.update(novel).set({ failStreak: 0 }).where(eq(novel.id, novelId));
            await logEvent(db, novelId, "success", `chapter ${ch.index} translated in ${duration}s (${result.attempts} ${result.attempts === 1 ? "request" : "requests"})`, ch.index);
            break;
        case "skipped":
            await db.update(chapter).set({ status: "skipped", error: result.reason, model }).where(eq(chapter.id, ch.id));
            await logEvent(db, novelId, "warning", `chapter ${ch.index} skipped: ${result.reason}`, ch.index);
            break;
        case "failed": {
            await db
                .update(chapter)
                .set({ status: "failed", error: result.reason, attempts: result.attempts, model, duration, ...tokens })
                .where(eq(chapter.id, ch.id));
            const [{ failStreak }] = await db
                .update(novel)
                .set({ failStreak: sql`${novel.failStreak} + 1` })
                .where(eq(novel.id, novelId))
                .returning({ failStreak: novel.failStreak });
            await logEvent(db, novelId, "error", `chapter ${ch.index} failed: ${result.reason}`, ch.index);
            await notifier.chapterFailed(n, ch.index, result.reason);
            if (failStreak >= MAX_FAIL_STREAK) {
                return halt(db, n, notifier, `${failStreak} chapters failed in a row, the run is paused`);
            }
            break;
        }
        case "paused": {
            await db.update(chapter).set({ status: "queued" }).where(eq(chapter.id, ch.id));
            await db
                .update(novel)
                .set({ status: "waiting", statusMessage: `Waiting for glossary decisions in chapter ${ch.index}` })
                .where(eq(novel.id, novelId));
            await logEvent(db, novelId, "warning", `chapter ${ch.index} waits for glossary decisions`, ch.index);
            await notifier.decisionsNeeded(n, ch.index);
            return "stop";
        }
    }

    if (n.decisionMode === "queue") {
        const [{ fresh }] = await db
            .select({ fresh: sql<number>`count(*)::int` })
            .from(termChange)
            .where(and(eq(termChange.novelId, novelId), eq(termChange.status, "pending"), gt(termChange.id, Number(lastChange))));
        if (fresh > 0) await notifier.decisionsNeeded(n, ch.index);
    }

    const [after] = await db.select({ status: novel.status, stop: novel.stopRequested }).from(novel).where(eq(novel.id, novelId));
    if (!after || after.status !== "running") {
        if (after?.stop) await db.update(novel).set({ stopRequested: false }).where(eq(novel.id, novelId));
        return "stop";
    }
    return "next";
}

async function halt(db: DB, n: typeof novel.$inferSelect, notifier: Notifier, reason: string): Promise<StepOutcome> {
    await db.update(novel).set({ status: "error", statusMessage: reason, failStreak: 0 }).where(eq(novel.id, n.id));
    await logEvent(db, n.id, "error", reason);
    await notifier.runHalted(n, reason);
    return "stop";
}
