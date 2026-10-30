"use server";

import { and, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TERM_TYPES } from "@ranobe-tl/core";
import { db } from "@/db";
import { batchJob, chapter, novel } from "@/db/schema";
import { logEvent } from "@/server/activity";
import { acceptGroup, adviseGroup, dismissGroup, groupSnippets } from "@/server/batch/merge";
import { batchSetup, submitExtraction, submitTranslation, type ExtractScope } from "@/server/batch/submit";
import { requestSync } from "@/server/queue";
import { scopeWhere, type RunScope } from "@/server/scope";
import { requireUser } from "@/server/session";
import { action } from "./util";

function refresh(novelId: number) {
    revalidatePath(`/novels/${novelId}`, "layout");
    revalidatePath("/");
}

/** Sends chapters to term extraction (one batch). */
export async function startExtraction(novelId: number, scope: ExtractScope) {
    return action(async () => {
        await requireUser();
        const count = await submitExtraction(db, novelId, scope);
        refresh(novelId);
        return { ok: true as const, message: `${count} chapters sent to term extraction` };
    });
}

/** Sends chapters to translation (one batch) with the glossary as it is now. */
export async function startBatchTranslation(novelId: number, scope: RunScope) {
    return action(async () => {
        await requireUser();
        const res = await submitTranslation(db, novelId, scopeWhere(scope));
        refresh(novelId);
        return { ok: true as const, message: `${res.chapters} chapters sent to translation${res.skipped ? `, ${res.skipped} skipped` : ""}` };
    });
}

/** Cancels the open batches; results that already came back are still applied. */
export async function cancelBatches(novelId: number) {
    return action(async () => {
        await requireUser();
        const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
        if (!n) throw new Error("Novel not found");
        const open = await db
            .select()
            .from(batchJob)
            .where(and(eq(batchJob.novelId, novelId), inArray(batchJob.status, ["in_progress", "canceling", "applying"])));
        const jobs = open.filter((j) => j.status === "in_progress");
        // a cancel already asked for, or results being applied right now: nothing to reset
        if (open.length && !jobs.length) {
            const applying = open.some((j) => j.status === "applying");
            return { ok: true as const, message: applying ? "The results are being applied right now" : "Already canceling; finished requests are kept" };
        }
        if (!jobs.length) {
            // nothing at the provider: a novel left "running" goes back to idle, chapters to what they were
            await db.update(novel).set({ status: "idle", statusMessage: "" }).where(eq(novel.id, novelId));
            await db
                .update(chapter)
                .set({ status: sql`case when ${chapter.content} is not null then 'done' else 'new' end`, batchState: null })
                .where(and(eq(chapter.novelId, novelId), eq(chapter.status, "translating")));
            refresh(novelId);
            return { ok: true as const, message: "No batch was running" };
        }
        const { client } = await batchSetup(db, n);
        for (const job of jobs) {
            await client.messages.batches.cancel(job.externalId);
            await db.update(batchJob).set({ status: "canceling" }).where(eq(batchJob.id, job.id));
        }
        await db.update(novel).set({ statusMessage: "Canceling the batch…" }).where(eq(novel.id, novelId));
        await logEvent(db, novelId, "warning", "batch canceled: what already came back is kept, the rest is dropped");
        refresh(novelId);
        return { ok: true as const, message: "Canceling; finished requests are kept" };
    });
}

const ChoiceSchema = z.object({
    target: z.string().trim().min(1, "Give the translation"),
    type: z.enum(TERM_TYPES),
    note: z.string().default(""),
    gender: z.enum(["m", "f", "unknown", "timeline"]),
});

export async function acceptCandidate(novelId: number, key: string, choice: z.input<typeof ChoiceSchema>) {
    return action(async () => {
        await requireUser();
        const res = await acceptGroup(db, novelId, key, ChoiceSchema.parse(choice));
        await requestSync(novelId);
        refresh(novelId);
        return res;
    });
}

/** Several terms at once, each with the model's advice or its most common translation. */
export async function acceptCandidates(novelId: number, items: { key: string; choice: z.input<typeof ChoiceSchema> }[]) {
    return action(async () => {
        await requireUser();
        // one term that cannot be merged (locked, merged meanwhile) does not stop the others
        const merged: string[] = [];
        const failed: { key: string; error: string }[] = [];
        for (const item of items) {
            try {
                await acceptGroup(db, novelId, item.key, ChoiceSchema.parse(item.choice));
                merged.push(item.key);
            } catch (error) {
                failed.push({ key: item.key, error: error instanceof Error ? error.message : String(error) });
            }
        }
        await requestSync(novelId);
        refresh(novelId);
        return {
            ok: true as const,
            data: { merged, failed },
            message: `${merged.length} terms merged${failed.length ? `, ${failed.length} not: ${failed.map((f) => `${f.key} (${f.error})`).join("; ")}` : ""}`,
        };
    });
}

export async function dismissCandidate(novelId: number, key: string, notATerm: boolean) {
    return action(async () => {
        await requireUser();
        await dismissGroup(db, novelId, key, notATerm);
        refresh(novelId);
    });
}

export async function candidateSnippets(novelId: number, key: string) {
    return action(async () => {
        await requireUser();
        return groupSnippets(db, novelId, key);
    });
}

export async function adviseCandidate(novelId: number, key: string) {
    return action(async () => {
        await requireUser();
        return adviseGroup(db, novelId, key);
    });
}
