import { and, eq } from "drizzle-orm";
import { chunkText, cleanSource } from "@ranobe-tl/core";
import type { DB } from "@/db";
import { chapter, novel, providerKey, type BatchChapterState } from "@/db/schema";
import { logEvent } from "./activity";
import { completeChapter } from "./batch/ingest";
import { novelConfig } from "./novel-config";
import { enqueueDirect, enqueueNovel, requestSync } from "./queue";
import { keepVersion } from "./versions";

/**
 * Takes a failed chapter's rejected translation as it is (validation is a heuristic: a source repeating itself,
 * a few merged paragraphs). When every part of the chapter came back, it is saved right away; otherwise the
 * parts that never came back are translated again, the taken ones are not.
 */
export async function acceptRejected(db: DB, novelId: number, index: number): Promise<{ done: boolean }> {
    const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
    const [ch] = await db
        .select()
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), eq(chapter.index, index)));
    if (!n || !ch) throw new Error("Chapter not found");
    const r = ch.rejected;
    if (ch.status !== "failed" || !r) throw new Error("This chapter has no rejected translation to take");
    const [key] = n.providerKeyId ? await db.select().from(providerKey).where(eq(providerKey.id, n.providerKeyId)) : [];
    const config = novelConfig(n, key);
    const chunks = chunkText(cleanSource(ch.source, config), config.chunkSize);
    const complete = r.parts.length === chunks.length && r.parts.every((p) => p !== null);

    if (complete) {
        const parts = r.parts as string[];
        await keepVersion(db, ch, "translation");
        await db
            .update(chapter)
            .set({
                status: "done",
                title: r.title?.trim() || chunks[0].split("\n")[0].trim(),
                content: parts.join("\n\n"),
                ratio: parts.reduce((a, p) => a + p.length, 0) / chunks.reduce((a, s) => a + s.length, 0),
                error: "",
                translatedAt: new Date(),
                rejected: null,
                batchState: null,
                draft: null,
            })
            .where(eq(chapter.id, ch.id));
        await logEvent(db, novelId, "info", "the rejected translation was taken as it is", index);
        await requestSync(novelId);
        return { done: true };
    }

    if (n.pipeline === "batch") {
        // the parts that never came back go out again right away, the taken ones stay
        const state: BatchChapterState = {
            sources: r.sources,
            parts: r.parts,
            title: r.title,
            attempts: r.sources.map(() => 0),
            feedback: r.sources.map(() => null),
            latin: r.sources.map(() => null),
        };
        await db.update(chapter).set({ status: "translating", batchState: state, rejected: null, error: "" }).where(eq(chapter.id, ch.id));
        if (state.parts.every((p) => p !== null)) {
            await completeChapter(db, { ...ch, status: "translating" }, state, ch.model);
            return { done: true };
        }
        await db.update(novel).set({ status: "running", statusMessage: `Translating the rest of chapter ${index}`, stopRequested: false }).where(eq(novel.id, novelId));
        await enqueueDirect(ch.id);
    } else {
        // chapter by chapter: the taken parts become a draft, the run translates only what follows
        const taken = r.parts.findIndex((p) => p === null);
        const count = taken === -1 ? r.parts.length : taken;
        await db
            .update(chapter)
            .set({
                status: "queued",
                draft: { sources: r.sources.slice(0, count), parts: r.parts.slice(0, count) as string[], title: r.title, terms: [] },
                rejected: null,
                error: "",
            })
            .where(eq(chapter.id, ch.id));
        if (n.status !== "running") {
            await db.update(novel).set({ status: "running", statusMessage: "Starting…", stopRequested: false, failStreak: 0 }).where(eq(novel.id, novelId));
            await enqueueNovel(novelId);
        }
    }
    await logEvent(db, novelId, "info", "the rejected part was taken as it is; the rest of the chapter is translated", index);
    return { done: false };
}
