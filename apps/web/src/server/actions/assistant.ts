"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/db";
import { ChatId, applyDraft, draftChanges, revertDraft } from "@/server/assistant-draft";
import { requestSync } from "@/server/queue";
import { requireUser } from "@/server/session";
import { action } from "./util";

const Chapters = z.array(z.number().int()).max(10_000);

/** The assistant's draft against the chapters it was made from. */
export async function getDraftChanges(novelId: number, chatId: string) {
    return action(async () => {
        await requireUser();
        return draftChanges(db, novelId, ChatId.parse(chatId));
    });
}

/** Writes the chosen chapters of the draft; each one's previous text stays in its history. */
export async function applyDraftChanges(novelId: number, chatId: string, chapters: number[]) {
    return action(async () => {
        await requireUser();
        const result = await applyDraft(db, novelId, ChatId.parse(chatId), Chapters.parse(chapters));
        if (result.applied.length) {
            revalidatePath(`/novels/${novelId}`, "layout");
            await requestSync(novelId);
        }
        return result;
    });
}

/** Puts the chosen chapters of the draft back as they were. */
export async function discardDraftChanges(novelId: number, chatId: string, chapters: number[]) {
    return action(async () => {
        await requireUser();
        await revertDraft(db, novelId, ChatId.parse(chatId), Chapters.parse(chapters));
    });
}
