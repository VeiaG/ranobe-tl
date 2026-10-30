import { and, eq, inArray, sql } from "drizzle-orm";
import {
    Glossary,
    messageText,
    messageUsage,
    parseExtraction,
    parseOutput,
    stopProblem,
    validateTranslation,
    looseKey,
    type BatchResult,
    type TranslationConfig,
    type Usage,
} from "@ranobe-tl/core";
import type { DB } from "@/db";
import { batchJob, chapter, novel, termCandidate, usageRecord, type BatchChapterState } from "@/db/schema";
import { logEvent } from "@/server/activity";
import { BATCH_SUFFIX } from "@/server/pricing";
import { PgGlossaryStore } from "@/server/glossary-store";
import { enqueueBatchPoll, requestSync } from "@/server/queue";
import { keepVersion } from "@/server/versions";
import { autoResolve } from "./merge";
import { batchSetup, createBatch, extractRequest, parseCustomId, translateRequest, type BatchRequest } from "./submit";

type Novel = typeof novel.$inferSelect;
type Job = typeof batchJob.$inferSelect;

export interface BatchNotifier {
    finished(n: Novel): Promise<void>;
    chapterFailed(n: Novel, index: number, reason: string): Promise<void>;
    runHalted(n: Novel, reason: string): Promise<void>;
}

/** Two Latin shares are "about the same": within half a percentage point or 15% of each other (as in the translator). */
function latinStable(previous: number, current: number): boolean {
    return Math.abs(previous - current) <= Math.max(0.5, previous * 0.15);
}

/**
 * Checks one batch. While it runs, its progress goes to the novel's status line and the poll comes back later.
 * When it has ended, the results are applied: candidates for extraction, chunks for translation, and what
 * failed validation goes out again in a follow-up batch until the attempts run out.
 */
export async function pollBatch(db: DB, batchJobId: number, notifier: BatchNotifier): Promise<void> {
    const [job] = await db.select().from(batchJob).where(eq(batchJob.id, batchJobId));
    if (!job || job.status === "ended" || job.status === "canceled" || job.status === "failed") return;
    const [n] = await db.select().from(novel).where(eq(novel.id, job.novelId));
    if (!n) return;

    let setup;
    try {
        setup = await batchSetup(db, n);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await db.update(batchJob).set({ status: "failed", error: reason, endedAt: new Date() }).where(eq(batchJob.id, job.id));
        await finishIfIdle(db, n, notifier, reason);
        return;
    }
    const batch = await setup.client.messages.batches.retrieve(job.externalId);
    const counts = batch.request_counts as unknown as Record<string, number>;
    await db.update(batchJob).set({ counts }).where(eq(batchJob.id, job.id));

    if (batch.processing_status !== "ended") {
        const done = counts.succeeded + counts.errored + counts.canceled + counts.expired;
        const what = job.kind === "extract" ? "Extracting terms" : "Translating";
        await db
            .update(novel)
            .set({ statusMessage: `${what}: ${done} of ${job.requests} requests done${job.status === "canceling" ? " · canceling" : ""}` })
            .where(eq(novel.id, n.id));
        await enqueueBatchPoll(job.id, "worker");
        return;
    }

    const results: BatchResult[] = [];
    for await (const r of await setup.client.messages.batches.results(job.externalId)) results.push(r);

    const canceled = job.status === "canceling";
    const retries =
        job.kind === "extract"
            ? await applyExtraction(db, n, job, results, setup, canceled)
            : await applyTranslation(db, n, job, results, setup.config, setup.model, notifier, canceled);
    await db.update(batchJob).set({ status: canceled ? "canceled" : "ended", endedAt: new Date() }).where(eq(batchJob.id, job.id));

    if (retries.requests.length) {
        try {
            await createBatch(db, n, job.kind, retries.requests, retries.chapterIds, "worker");
            await logEvent(db, n.id, "info", `${retries.requests.length} requests sent again (batch)`);
            return;
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            // the chapters waiting for these requests cannot finish now
            if (job.kind === "translate") {
                await db
                    .update(chapter)
                    .set({ status: "failed", error: `not sent again: ${reason}`, batchState: null })
                    .where(and(inArray(chapter.id, retries.chapterIds.length ? retries.chapterIds : [-1]), eq(chapter.status, "translating")));
            }
            await finishIfIdle(db, n, notifier, reason);
            return;
        }
    }
    await finishIfIdle(db, n, notifier);
}

/** After a batch: with no other batch open the novel is idle again (or in error, with a reason). */
async function finishIfIdle(db: DB, n: Novel, notifier: BatchNotifier, error?: string): Promise<void> {
    const open = await db
        .select({ id: batchJob.id })
        .from(batchJob)
        .where(and(eq(batchJob.novelId, n.id), inArray(batchJob.status, ["in_progress", "canceling"])))
        .limit(1);
    if (open.length) return;
    if (error) {
        await db.update(novel).set({ status: "error", statusMessage: error }).where(eq(novel.id, n.id));
        await logEvent(db, n.id, "error", error);
        await notifier.runHalted(n, error);
        return;
    }
    await db.update(novel).set({ status: "idle", statusMessage: "", stopRequested: false }).where(eq(novel.id, n.id));
    await notifier.finished(n);
}

async function recordUsage(db: DB, n: Novel, job: Job, usage: Usage, ok: boolean, at: { chapter: number; chunk?: number; attempt: number }) {
    await db.insert(usageRecord).values({
        novelId: n.id,
        novelTitle: n.title,
        chapter: at.chapter,
        chunk: at.chunk ?? null,
        attempt: at.attempt,
        keyId: job.keyId,
        provider: "anthropic",
        model: `${job.model}${BATCH_SUFFIX}`,
        inputTokens: usage.input,
        cachedTokens: usage.cachedInput,
        outputTokens: usage.output,
        ok,
    });
    await db
        .update(novel)
        .set({
            inputTokens: sql`${novel.inputTokens} + ${usage.input}`,
            cachedTokens: sql`${novel.cachedTokens} + ${usage.cachedInput}`,
            outputTokens: sql`${novel.outputTokens} + ${usage.output}`,
        })
        .where(eq(novel.id, n.id));
}

function resultError(r: BatchResult): string {
    if (r.result.type === "errored") return `request failed: ${r.result.error.error.message}`;
    return r.result.type === "expired" ? "the batch expired before this request ran" : "canceled";
}

async function applyExtraction(
    db: DB,
    n: Novel,
    job: Job,
    results: BatchResult[],
    setup: Awaited<ReturnType<typeof batchSetup>>,
    canceled: boolean
): Promise<{ requests: BatchRequest[]; chapterIds: number[] }> {
    const { config, model, extractEffort } = setup;
    const ids = results.flatMap((r) => {
        const id = parseCustomId(r.custom_id);
        return id?.kind === "extract" ? [id.chapterId] : [];
    });
    const chapters = new Map((ids.length ? await db.select().from(chapter).where(inArray(chapter.id, ids)) : []).map((c) => [c.id, c]));
    const retry: BatchRequest[] = [];
    const retryIds: number[] = [];
    let glossary: Glossary | undefined;
    let extracted = 0;
    let failed = 0;

    for (const r of results) {
        const id = parseCustomId(r.custom_id);
        const ch = id && chapters.get(id.chapterId);
        if (!id || id.kind !== "extract" || !ch) continue;
        let problem: string;
        if (r.result.type === "succeeded") {
            const message = r.result.message;
            const parsed = parseExtraction(messageText(message));
            const stop = stopProblem(message);
            problem = stop ?? parsed.problems.join("; ");
            await recordUsage(db, n, job, messageUsage(message), !problem, { chapter: ch.index, attempt: id.attempt });
            if (!problem) {
                // a chapter extracted again replaces what it gave before
                await db.delete(termCandidate).where(and(eq(termCandidate.novelId, n.id), eq(termCandidate.chapter, ch.index)));
                if (parsed.terms.length) {
                    await db.insert(termCandidate).values(
                        parsed.terms.map((t) => ({
                            novelId: n.id,
                            chapter: ch.index,
                            source: t.source,
                            groupKey: looseKey(t.source),
                            target: t.target,
                            type: t.type,
                            gender: t.gender ?? null,
                            note: t.note ?? "",
                            evidence: t.evidence ?? "",
                        }))
                    );
                }
                await db.update(chapter).set({ extractedAt: new Date() }).where(eq(chapter.id, ch.id));
                extracted++;
                continue;
            }
        } else {
            problem = resultError(r);
        }
        if (canceled || r.result.type === "canceled") continue;
        if (id.attempt < config.maxAttempts) {
            glossary ??= await Glossary.load(new PgGlossaryStore(db, n.id), { fixedTerms: config.fixedTerms });
            const req = extractRequest(config, model, extractEffort, glossary, ch, id.attempt + 1);
            if (req) {
                retry.push(req);
                retryIds.push(ch.id);
            }
            await logEvent(db, n.id, "warning", `term extraction, attempt ${id.attempt}: ${problem}`, ch.index);
        } else {
            failed++;
            await logEvent(db, n.id, "error", `term extraction failed: ${problem}`, ch.index);
        }
    }

    const merged = await autoResolve(db, n.id);
    await logEvent(
        db,
        n.id,
        merged.conflicts ? "warning" : "success",
        `terms extracted from ${extracted} chapters${failed ? ` (${failed} failed)` : ""}: ${merged.added} new terms added, ${merged.matched} matched the glossary${merged.conflicts ? `, ${merged.conflicts} wait in Candidates` : ""}`
    );
    return { requests: retry, chapterIds: retryIds };
}

async function applyTranslation(
    db: DB,
    n: Novel,
    job: Job,
    results: BatchResult[],
    config: TranslationConfig,
    model: string,
    notifier: BatchNotifier,
    canceled: boolean
): Promise<{ requests: BatchRequest[]; chapterIds: number[] }> {
    const byChapter = new Map<number, { result: BatchResult; chunk: number; attempt: number }[]>();
    for (const r of results) {
        const id = parseCustomId(r.custom_id);
        if (id?.kind !== "translate") continue;
        byChapter.set(id.chapterId, [...(byChapter.get(id.chapterId) ?? []), { result: r, chunk: id.chunk, attempt: id.attempt }]);
    }
    const ids = [...byChapter.keys()];
    const chapters = ids.length ? await db.select().from(chapter).where(inArray(chapter.id, ids)) : [];
    const retry: BatchRequest[] = [];
    const retryIds: number[] = [];
    let glossary: Glossary | undefined;
    let done = 0;
    let failed = 0;

    for (const ch of chapters) {
        const items = byChapter.get(ch.id)!;
        const state = ch.batchState;
        // reset, edited or sent again meanwhile: the tokens were spent all the same
        const live = ch.status === "translating" && state;
        const tokens = { input: 0, cachedInput: 0, output: 0 };

        for (const { result: r, chunk: c, attempt } of items) {
            if (r.result.type !== "succeeded") {
                if (live && c < state.sources.length) {
                    state.attempts[c] = Math.max(state.attempts[c], attempt);
                    state.feedback[c] = null;
                    if (r.result.type !== "canceled") await logEvent(db, n.id, "warning", `chunk ${c + 1}, attempt ${attempt}: ${resultError(r)}`, ch.index);
                }
                continue;
            }
            const message = r.result.message;
            const usage = messageUsage(message);
            tokens.input += usage.input;
            tokens.cachedInput += usage.cachedInput;
            tokens.output += usage.output;
            if (!live || c >= state.sources.length) {
                await recordUsage(db, n, job, usage, false, { chapter: ch.index, chunk: c, attempt });
                continue;
            }
            state.attempts[c] = Math.max(state.attempts[c], attempt);
            const parsed = parseOutput(messageText(message));
            const stop = stopProblem(message);
            const v = validateTranslation(state.sources[c], parsed.translation, config, [...parsed.problems, ...(stop ? [stop] : [])]);
            const latinAccepted = !v.ok && v.latinOnly && state.latin[c] !== null && latinStable(state.latin[c]!, v.latinPercent);
            await recordUsage(db, n, job, usage, v.ok || latinAccepted, { chapter: ch.index, chunk: c, attempt });
            if (v.ok || latinAccepted) {
                state.parts[c] = parsed.translation;
                state.feedback[c] = null;
                if (c === 0) state.title = parsed.title;
                if (latinAccepted) await logEvent(db, n.id, "info", `chunk ${c + 1}, attempt ${attempt}: accepted, the Latin share is stable across attempts`, ch.index);
            } else {
                state.feedback[c] = v.problems.join("; ");
                state.latin[c] = v.latinOnly ? v.latinPercent : null;
                await logEvent(db, n.id, "warning", `chunk ${c + 1}, attempt ${attempt}: ${state.feedback[c]}`, ch.index);
            }
        }

        const addTokens = {
            inputTokens: sql`${chapter.inputTokens} + ${tokens.input}`,
            cachedTokens: sql`${chapter.cachedTokens} + ${tokens.cachedInput}`,
            outputTokens: sql`${chapter.outputTokens} + ${tokens.output}`,
        };
        if (!live) {
            await db.update(chapter).set(addTokens).where(eq(chapter.id, ch.id));
            continue;
        }
        const attempts = state.attempts.reduce((a, b) => a + b, 0);
        if (state.parts.every((p) => p !== null)) {
            const sourceLength = state.sources.reduce((a, s) => a + s.length, 0);
            const parts = state.parts as string[];
            await keepVersion(db, ch, "translation");
            await db
                .update(chapter)
                .set({
                    status: "done",
                    title: state.title?.trim() || state.sources[0].split("\n")[0].trim(),
                    content: parts.join("\n\n"),
                    attempts,
                    ratio: parts.reduce((a, p) => a + p.length, 0) / sourceLength,
                    error: "",
                    model,
                    // the time a batch waits says nothing about a chapter (the overview's ETA is for chapter by chapter)
                    duration: null,
                    translatedAt: new Date(),
                    batchState: null,
                    ...addTokens,
                })
                .where(eq(chapter.id, ch.id));
            done++;
            continue;
        }

        const missing = state.parts.flatMap((p, c) => (p === null ? [c] : []));
        const exhausted = missing.find((c) => state.attempts[c] >= config.maxAttempts);
        if (canceled || exhausted !== undefined) {
            const reason = canceled ? "the batch was canceled" : `chunk ${exhausted! + 1}/${state.sources.length}: ${state.feedback[exhausted!] ?? "no usable reply"}`;
            await db
                .update(chapter)
                .set(canceled ? { status: ch.content ? "done" : "new", batchState: null, ...addTokens } : { status: "failed", error: reason, attempts, model, batchState: null, ...addTokens })
                .where(eq(chapter.id, ch.id));
            if (!canceled) {
                failed++;
                await logEvent(db, n.id, "error", `chapter ${ch.index} failed: ${reason}`, ch.index);
                await notifier.chapterFailed(n, ch.index, reason);
            }
            continue;
        }
        glossary ??= await Glossary.load(new PgGlossaryStore(db, n.id), { fixedTerms: config.fixedTerms });
        for (const c of missing) retry.push(translateRequest(config, model, glossary, ch, state, c));
        retryIds.push(ch.id);
        await db.update(chapter).set({ batchState: state, attempts, ...addTokens }).where(eq(chapter.id, ch.id));
    }

    // chapters of this batch without any result (should not happen) must not stay "translating" forever
    const lost = job.chapterIds.filter((id) => !byChapter.has(id));
    if (lost.length) {
        await db
            .update(chapter)
            .set({ status: "failed", error: "no result came back from the batch", batchState: null })
            .where(and(inArray(chapter.id, lost), eq(chapter.status, "translating")));
    }

    if (done) await requestSync(n.id, "worker");
    await logEvent(
        db,
        n.id,
        failed ? "warning" : "success",
        `batch finished: ${done} chapters translated${failed ? `, ${failed} failed` : ""}${retryIds.length ? `, ${retryIds.length} go out again` : ""}`
    );
    return { requests: retry, chapterIds: retryIds };
}
