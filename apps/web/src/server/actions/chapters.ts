"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cleanSource, leadingTitle } from "@ranobe-tl/core";
import { db } from "@/db";
import { chapter, chapterVersion, novel, providerKey } from "@/db/schema";
import { novelConfig } from "@/server/novel-config";
import { requestSync } from "@/server/queue";
import { acceptRejected } from "@/server/rejected";
import { keepVersion } from "@/server/versions";
import { requireUser } from "@/server/session";
import { action } from "./util";

export async function deleteChapters(novelId: number, indexes: number[]) {
    return action(async () => {
        await requireUser();
        const [n] = await db.select({ status: novel.status }).from(novel).where(eq(novel.id, novelId));
        if (n?.status === "running") throw new Error("Pause the run before deleting chapters");
        await db.delete(chapter).where(and(eq(chapter.novelId, novelId), inArray(chapter.index, indexes.length ? indexes : [-1])));
        revalidatePath(`/novels/${novelId}`, "layout");
    });
}

/** Drops the translation but keeps the source, so the chapter can be translated again (the text stays in its history). */
export async function resetChapters(novelId: number, indexes: number[]) {
    return action(async () => {
        await requireUser();
        const current = await db
            .select()
            .from(chapter)
            .where(and(eq(chapter.novelId, novelId), inArray(chapter.index, indexes.length ? indexes : [-1])));
        for (const c of current) await keepVersion(db, c, "reset");
        await db
            .update(chapter)
            .set({ status: "new", title: null, content: null, error: "", attempts: 0, ratio: null, translatedAt: null })
            .where(and(eq(chapter.novelId, novelId), inArray(chapter.index, indexes.length ? indexes : [-1]), inArray(chapter.status, ["done", "failed", "skipped", "new", "queued"])));
        revalidatePath(`/novels/${novelId}`, "layout");
    });
}

/** Saves a hand-edited translation; the previous text stays in the chapter's history. */
export async function saveTranslation(novelId: number, index: number, input: { title: string; content: string }) {
    return action(async () => {
        await requireUser();
        const [current] = await db
            .select()
            .from(chapter)
            .where(and(eq(chapter.novelId, novelId), eq(chapter.index, index)));
        if (!current) throw new Error("Chapter not found");
        if (current.status === "translating") throw new Error("The chapter is being translated right now; wait for it or reset it first");
        if (!input.content.trim()) throw new Error("The translation is empty");
        await keepVersion(db, current, "edit");
        await db
            .update(chapter)
            .set({
                title: input.title.trim(),
                content: input.content.replace(/\r\n/g, "\n").trim(),
                status: "done",
                error: "",
                translatedAt: new Date(),
                model: "edited by hand",
                rejected: null,
                draft: null,
                batchState: null,
            })
            .where(and(eq(chapter.novelId, novelId), eq(chapter.index, index)));
        revalidatePath(`/novels/${novelId}`, "layout");
        await requestSync(novelId);
        return { ok: true as const, message: "Translation saved" };
    });
}

/** Puts an earlier version back; the text it replaces becomes a version itself. */
export async function restoreVersion(novelId: number, index: number, versionId: number) {
    return action(async () => {
        await requireUser();
        const [current] = await db
            .select()
            .from(chapter)
            .where(and(eq(chapter.novelId, novelId), eq(chapter.index, index)));
        if (!current) throw new Error("Chapter not found");
        const [v] = await db
            .select()
            .from(chapterVersion)
            .where(and(eq(chapterVersion.id, versionId), eq(chapterVersion.chapterId, current.id)));
        if (!v) throw new Error("That version is gone");
        await keepVersion(db, current, "restore");
        await db.delete(chapterVersion).where(eq(chapterVersion.id, v.id));
        await db
            .update(chapter)
            .set({ title: v.title, content: v.content, model: v.model, translatedAt: v.translatedAt ?? new Date(), status: "done", error: "" })
            .where(eq(chapter.id, current.id));
        revalidatePath(`/novels/${novelId}`, "layout");
        await requestSync(novelId);
        return { ok: true as const, message: "Version restored" };
    });
}

/** Takes a failed chapter's rejected translation anyway (validation is a heuristic). */
export async function acceptRejectedTranslation(novelId: number, index: number) {
    return action(async () => {
        await requireUser();
        const res = await acceptRejected(db, novelId, index);
        revalidatePath(`/novels/${novelId}`, "layout");
        return { ok: true as const, data: res, message: res.done ? "Taken as it is" : "Taken; the rest of the chapter is being translated" };
    });
}

/**
 * Chapters whose title stayed in the source language while the translated title opened the text
 * (the model left out the <title> block): the first line of the text becomes the title.
 */
export async function fixLeadingTitles(novelId: number) {
    return action(async () => {
        await requireUser();
        const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
        if (!n) throw new Error("Novel not found");
        const [key] = n.providerKeyId ? await db.select().from(providerKey).where(eq(providerKey.id, n.providerKeyId)) : [];
        const config = novelConfig(n, key);
        const rows = await db
            .select()
            .from(chapter)
            .where(and(eq(chapter.novelId, novelId), eq(chapter.status, "done")));
        let fixed = 0;
        for (const c of rows) {
            if (!c.content || !c.title) continue;
            const source = cleanSource(c.source, config);
            const sourceTitle = source.split("\n").find((l) => l.trim())?.trim();
            if (c.title.trim() !== sourceTitle) continue;
            const head = leadingTitle(source, c.content);
            if (!head) continue;
            await keepVersion(db, c, "edit");
            await db.update(chapter).set({ title: head.title, content: head.content }).where(eq(chapter.id, c.id));
            fixed++;
        }
        revalidatePath(`/novels/${novelId}`, "layout");
        if (fixed) await requestSync(novelId);
        return { ok: true as const, message: fixed ? `Titles fixed in ${fixed} chapters` : "No chapter with the title left in the text" };
    });
}
