import { and, asc, between, eq, inArray, isNull, ne, type SQL } from "drizzle-orm";
import {
    Glossary,
    batchClient,
    batchParams,
    batchSystemPrompt,
    batchUserPrompt,
    checkSource,
    chunkText,
    cleanSource,
    extractSystemPrompt,
    extractUserPrompt,
    resolveModelId,
    type BatchParams,
    type TranslationConfig,
} from "@ranobe-tl/core";
import type { DB } from "@/db";
import { batchJob, chapter, novel, providerKey, type BatchChapterState, type BatchKind } from "@/db/schema";
import { decrypt } from "@/lib/crypto";
import { logEvent } from "@/server/activity";
import { budgetStop } from "@/server/budget";
import { PgGlossaryStore } from "@/server/glossary-store";
import { novelConfig, novelSettings } from "@/server/novel-config";
import { enqueueBatchPoll } from "@/server/queue";

type Novel = typeof novel.$inferSelect;
type Chapter = typeof chapter.$inferSelect;
type Role = "web" | "worker";

/** Reasoning plus a list of terms; a chapter's terms never need more. */
const EXTRACT_MAX_TOKENS = 16000;

export interface BatchRequest {
    custom_id: string;
    params: BatchParams;
}

/** Key, model and settings of a batch novel; throws a message for the user when something is missing. */
export async function batchSetup(db: DB, n: Novel) {
    if (n.pipeline !== "batch") throw new Error("This novel is translated chapter by chapter");
    if (!n.providerKeyId) throw new Error("Choose an API key in the novel settings first");
    const [key] = await db.select().from(providerKey).where(eq(providerKey.id, n.providerKeyId));
    if (!key) throw new Error("The novel's API key was deleted; choose another in the settings");
    if (key.provider !== "anthropic") throw new Error("Batch translation works with Anthropic keys only");
    const config = novelConfig(n, key);
    return {
        key,
        config,
        model: resolveModelId(config),
        extractEffort: novelSettings(n).extractEffort ?? config.effort,
        client: batchClient(decrypt(key.encryptedKey), key.baseURL),
    };
}

/** Request ids carry what the result belongs to: "e-<chapter id>-<attempt>", "t-<chapter id>-<chunk>-<attempt>". */
export function parseCustomId(id: string): { kind: "extract"; chapterId: number; attempt: number } | { kind: "translate"; chapterId: number; chunk: number; attempt: number } | undefined {
    const e = id.match(/^e-(\d+)-(\d+)$/);
    if (e) return { kind: "extract", chapterId: Number(e[1]), attempt: Number(e[2]) };
    const t = id.match(/^t-(\d+)-(\d+)-(\d+)$/);
    if (t) return { kind: "translate", chapterId: Number(t[1]), chunk: Number(t[2]), attempt: Number(t[3]) };
    return undefined;
}

/** Sends the requests as one batch and starts polling it. The novel shows as running while a batch is open. */
export async function createBatch(db: DB, n: Novel, kind: BatchKind, requests: BatchRequest[], chapterIds: number[], role: Role = "web"): Promise<number> {
    const { client, key, model } = await batchSetup(db, n);
    const overBudget = await budgetStop(db, n, key);
    if (overBudget) throw new Error(overBudget);
    const batch = await client.messages.batches.create({ requests });
    const [job] = await db
        .insert(batchJob)
        .values({ novelId: n.id, kind, externalId: batch.id, keyId: key.id, model, chapterIds, requests: requests.length })
        .returning({ id: batchJob.id });
    await db
        .update(novel)
        .set({ status: "running", statusMessage: `${kind === "extract" ? "Extracting terms" : "Translating"}: batch of ${requests.length} requests sent`, stopRequested: false, failStreak: 0 })
        .where(eq(novel.id, n.id));
    await enqueueBatchPoll(job.id, role);
    return job.id;
}

/** The glossary as the batch requests see it: fixed terms plus everything merged so far. */
async function loadGlossary(db: DB, novelId: number, config: TranslationConfig) {
    return Glossary.load(new PgGlossaryStore(db, novelId), { fixedTerms: config.fixedTerms });
}

export type ExtractScope = { kind: "missing" } | { kind: "range"; from: number; to: number } | { kind: "chapters"; indexes: number[] };

function extractWhere(scope: ExtractScope): SQL | undefined {
    if (scope.kind === "missing") return isNull(chapter.extractedAt);
    if (scope.kind === "range") return between(chapter.index, Math.min(scope.from, scope.to), Math.max(scope.from, scope.to));
    return inArray(chapter.index, scope.indexes.length ? scope.indexes : [-1]);
}

export function extractRequest(
    config: TranslationConfig,
    model: string,
    effort: TranslationConfig["effort"],
    glossary: Glossary,
    ch: Pick<Chapter, "id" | "index" | "source">,
    attempt: number
): BatchRequest | undefined {
    const text = cleanSource(ch.source, config);
    if (!checkSource(text, config).ok) return undefined;
    return {
        custom_id: `e-${ch.id}-${attempt}`,
        params: batchParams({
            model,
            system: extractSystemPrompt(config),
            prompt: extractUserPrompt({ text, terms: glossary.relevant(text), chapter: ch.index }),
            maxTokens: EXTRACT_MAX_TOKENS,
            effort,
        }),
    };
}

/** Sends the chapters of the scope to term extraction. Returns how many went out. */
export async function submitExtraction(db: DB, novelId: number, scope: ExtractScope): Promise<number> {
    const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
    if (!n) throw new Error("Novel not found");
    const { config, model, extractEffort } = await batchSetup(db, n);
    const rows = await db
        .select({ id: chapter.id, index: chapter.index, source: chapter.source })
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), extractWhere(scope)))
        .orderBy(asc(chapter.index));
    const glossary = await loadGlossary(db, novelId, config);
    const requests: BatchRequest[] = [];
    const ids: number[] = [];
    for (const ch of rows) {
        const req = extractRequest(config, model, extractEffort, glossary, ch, 1);
        if (!req) continue;
        requests.push(req);
        ids.push(ch.id);
    }
    if (!requests.length) throw new Error("No chapters to extract terms from in this selection");
    await createBatch(db, n, "extract", requests, ids);
    await logEvent(db, novelId, "info", `term extraction sent for ${requests.length} chapters (batch)`);
    return requests.length;
}

/** The request of one chunk of a chapter in flight; the attempt is the next one. */
export function translateRequest(config: TranslationConfig, model: string, glossary: Glossary, ch: Pick<Chapter, "id" | "index">, state: BatchChapterState, c: number): BatchRequest {
    const text = state.sources[c];
    return {
        custom_id: `t-${ch.id}-${c}-${state.attempts[c] + 1}`,
        params: batchParams({
            model,
            system: batchSystemPrompt(config),
            prompt: batchUserPrompt({
                text,
                terms: glossary.relevant(text),
                chapter: ch.index,
                chunk: c,
                totalChunks: state.sources.length,
                sourceContext: c > 0 && config.contextChars > 0 ? state.sources[c - 1].slice(-config.contextChars) : undefined,
                feedback: state.feedback[c] ?? undefined,
            }),
            maxTokens: config.maxOutputTokens,
            effort: config.effort,
        }),
    };
}

/**
 * Sends chapters to translation with the glossary as it is now: every chunk of every chapter is one request.
 * Chapters with an unusable source are skipped right away. Returns how many chapters went out.
 */
export async function submitTranslation(db: DB, novelId: number, where: SQL | undefined): Promise<{ chapters: number; skipped: number }> {
    const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
    if (!n) throw new Error("Novel not found");
    const { config, model } = await batchSetup(db, n);
    // a chapter already in a batch is not sent twice
    const rows = await db
        .select()
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), where, ne(chapter.status, "translating")))
        .orderBy(asc(chapter.index));
    const glossary = await loadGlossary(db, novelId, config);

    const requests: BatchRequest[] = [];
    const states = new Map<number, BatchChapterState>();
    let skipped = 0;
    for (const ch of rows) {
        const source = cleanSource(ch.source, config);
        const check = checkSource(source, config);
        if (!check.ok) {
            await db.update(chapter).set({ status: "skipped", error: check.reason!, model, batchState: null }).where(eq(chapter.id, ch.id));
            skipped++;
            continue;
        }
        const sources = chunkText(source, config.chunkSize);
        const state: BatchChapterState = { sources, parts: sources.map(() => null), attempts: sources.map(() => 0), feedback: sources.map(() => null), latin: sources.map(() => null) };
        states.set(ch.id, state);
        sources.forEach((_, c) => requests.push(translateRequest(config, model, glossary, ch, state, c)));
    }
    if (!requests.length) {
        if (skipped) await logEvent(db, novelId, "warning", `${skipped} chapters skipped: their source is too short or broken`);
        throw new Error(skipped ? "Every chapter of this selection was skipped (source too short or broken)" : "Nothing to translate in this selection");
    }

    const ids = [...states.keys()];
    await createBatch(db, n, "translate", requests, ids);
    for (const [id, state] of states) {
        await db
            .update(chapter)
            .set({ status: "translating", batchState: state, error: "", draft: null, inputTokens: 0, cachedTokens: 0, outputTokens: 0, attempts: 0 })
            .where(eq(chapter.id, id));
    }
    await logEvent(db, novelId, "info", `${ids.length} chapters sent to translation (batch of ${requests.length} requests)${skipped ? `, ${skipped} skipped` : ""}`);
    return { chapters: ids.length, skipped };
}
