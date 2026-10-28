"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/db";
import { TERM_TYPES } from "@ranobe-tl/core";
import { DECISION_MODES, novel } from "@/db/schema";
import { NovelSettingsSchema } from "@/server/novel-config";
import { requestSync } from "@/server/queue";
import { requireUser } from "@/server/session";
import { action } from "./util";

const NovelBaseSchema = z.object({
    title: z.string().trim().min(1, "Give the novel a title").max(300),
    originalTitle: z.string().trim().max(300).default(""),
    synopsis: z.string().trim().max(5000).default(""),
    sourceLanguage: z.string().trim().min(1).default("English"),
    targetLanguage: z.string().trim().min(1).default("Ukrainian"),
    providerKeyId: z.number().int().nullable().default(null),
    model: z.string().trim().default(""),
    decisionMode: z.enum(DECISION_MODES).default("queue"),
    /** Total spending cap in USD; null = no cap. */
    budgetUsd: z.number().min(0).nullable().default(null),
    /** null: new terms are added without asking. */
    askNew: z
        .object({
            types: z.array(z.enum(TERM_TYPES)).optional(),
            untilChapter: z.number().int().min(1).optional(),
        })
        .nullable()
        .default(null),
});

export type NovelInput = z.input<typeof NovelBaseSchema>;

export async function createNovel(input: NovelInput) {
    const result = await action(async () => {
        const user = await requireUser();
        const data = NovelBaseSchema.parse(input);
        const [row] = await db
            .insert(novel)
            .values({ ...data, createdBy: user.id })
            .returning({ id: novel.id });
        return row.id;
    });
    if (result.ok) redirect(`/novels/${result.data}/chapters?upload=1`);
    return result;
}

export async function updateNovel(id: number, input: NovelInput & { settings?: unknown }) {
    return action(async () => {
        await requireUser();
        const data = NovelBaseSchema.parse(input);
        const settings = input.settings === undefined ? undefined : NovelSettingsSchema.parse(input.settings);
        await db
            .update(novel)
            .set({ ...data, ...(settings ? { settings } : {}) })
            .where(eq(novel.id, id));
        revalidatePath(`/novels/${id}`, "layout");
        await requestSync(id);
        return { ok: true as const, message: "Saved" };
    });
}

export async function deleteNovel(id: number) {
    const result = await action(async () => {
        await requireUser();
        const [n] = await db.select({ status: novel.status }).from(novel).where(eq(novel.id, id));
        if (n?.status === "running") throw new Error("Stop the run before deleting the novel");
        await db.delete(novel).where(eq(novel.id, id));
    });
    if (result.ok) {
        revalidatePath("/", "layout");
        redirect("/");
    }
    return result;
}

export async function updateNovelSettings(id: number, settings: unknown) {
    return action(async () => {
        await requireUser();
        const parsed = NovelSettingsSchema.parse(settings);
        for (const p of parsed.patternsToRemove ?? []) {
            try {
                new RegExp(p, "gim");
            } catch {
                throw new Error(`Not a valid regular expression: ${p}`);
            }
        }
        await db.update(novel).set({ settings: parsed }).where(eq(novel.id, id));
        revalidatePath(`/novels/${id}`, "layout");
        await requestSync(id);
        return { ok: true as const, message: "Translation settings saved" };
    });
}
