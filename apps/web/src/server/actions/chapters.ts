"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { chapter, chapterVersion, novel } from "@/db/schema";
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
        await keepVersion(db, current, "edit");
        await db
            .update(chapter)
            .set({ title: input.title.trim(), content: input.content.replace(/\r\n/g, "\n").trim(), status: "done", error: "", translatedAt: new Date(), model: "edited by hand" })
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
