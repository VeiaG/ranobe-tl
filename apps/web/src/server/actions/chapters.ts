"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { chapter, novel } from "@/db/schema";
import { requestSync } from "@/server/queue";
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

/** Drops the translation but keeps the source, so the chapter can be translated again. */
export async function resetChapters(novelId: number, indexes: number[]) {
    return action(async () => {
        await requireUser();
        await db
            .update(chapter)
            .set({ status: "new", title: null, content: null, error: "", attempts: 0, ratio: null, translatedAt: null })
            .where(and(eq(chapter.novelId, novelId), inArray(chapter.index, indexes.length ? indexes : [-1]), inArray(chapter.status, ["done", "failed", "skipped", "new", "queued"])));
        revalidatePath(`/novels/${novelId}`, "layout");
    });
}

/** Saves a hand-edited translation. */
export async function saveTranslation(novelId: number, index: number, input: { title: string; content: string }) {
    return action(async () => {
        await requireUser();
        await db
            .update(chapter)
            .set({ title: input.title.trim(), content: input.content.replace(/\r\n/g, "\n").trim(), status: "done", error: "", translatedAt: new Date(), model: "edited by hand" })
            .where(and(eq(chapter.novelId, novelId), eq(chapter.index, index)));
        revalidatePath(`/novels/${novelId}`, "layout");
        await requestSync(novelId);
        return { ok: true as const, message: "Translation saved" };
    });
}
