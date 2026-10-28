"use server";

import { and, between, eq, inArray, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import { chapter, novel, type ChapterStatus } from "@/db/schema";
import { logEvent } from "@/server/activity";
import { enqueueNovel } from "@/server/queue";
import { requireUser } from "@/server/session";
import { action } from "./util";

export type RunScope =
    | { kind: "untranslated" }
    | { kind: "failed" }
    | { kind: "range"; from: number; to: number; retranslate: boolean }
    | { kind: "chapters"; indexes: number[] };

function refresh(novelId: number) {
    revalidatePath(`/novels/${novelId}`, "layout");
    revalidatePath("/");
}

/** Queues chapters by scope and starts (or keeps) the run. */
export async function startRun(novelId: number, scope: RunScope) {
    return action(async () => {
        await requireUser();
        const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
        if (!n) throw new Error("novel not found");
        if (!n.providerKeyId) throw new Error("Choose an API key in the novel settings first");

        let where;
        if (scope.kind === "untranslated") where = inArray(chapter.status, ["new"] satisfies ChapterStatus[]);
        else if (scope.kind === "failed") where = inArray(chapter.status, ["failed"] satisfies ChapterStatus[]);
        else if (scope.kind === "range") {
            const statuses: ChapterStatus[] = scope.retranslate ? ["new", "failed", "skipped", "done"] : ["new", "failed"];
            where = and(between(chapter.index, Math.min(scope.from, scope.to), Math.max(scope.from, scope.to)), inArray(chapter.status, statuses));
        } else {
            where = and(inArray(chapter.index, scope.indexes.length ? scope.indexes : [-1]), inArray(chapter.status, ["new", "failed", "skipped", "done"] satisfies ChapterStatus[]));
        }
        const queued = await db
            .update(chapter)
            .set({ status: "queued" })
            .where(and(eq(chapter.novelId, novelId), where))
            .returning({ index: chapter.index });

        const [{ waiting }] = await db
            .select({ waiting: sql<number>`count(*)::int` })
            .from(chapter)
            .where(and(eq(chapter.novelId, novelId), inArray(chapter.status, ["queued", "translating"])));
        if (!waiting) return { ok: false as const, error: "Nothing to translate in this selection" };

        await db
            .update(novel)
            .set({ status: "running", statusMessage: "Starting…", stopRequested: false, failStreak: 0 })
            .where(eq(novel.id, novelId));
        await logEvent(db, novelId, "info", queued.length ? `queued ${queued.length} chapters, run started` : "run resumed");
        await enqueueNovel(novelId);
        refresh(novelId);
        return { ok: true as const, message: queued.length ? `Queued ${queued.length} chapters` : "Run resumed" };
    });
}

/** Lets the chapter in flight finish, then stops. */
export async function pauseRun(novelId: number) {
    return action(async () => {
        await requireUser();
        await db.update(novel).set({ status: "paused", statusMessage: "" }).where(eq(novel.id, novelId));
        await logEvent(db, novelId, "info", "run paused (the chapter in flight will finish)");
        refresh(novelId);
    });
}

/** Aborts the chapter in flight right away; nothing is saved for it. */
export async function stopNow(novelId: number) {
    return action(async () => {
        await requireUser();
        await db.update(novel).set({ status: "paused", statusMessage: "", stopRequested: true }).where(eq(novel.id, novelId));
        await db
            .update(chapter)
            .set({ status: "queued" })
            .where(and(eq(chapter.novelId, novelId), eq(chapter.status, "translating")));
        await logEvent(db, novelId, "warning", "stop requested: aborting the chapter in flight");
        refresh(novelId);
    });
}

/** Continues a paused, stopped or waiting run with what is already queued. */
export async function resumeRun(novelId: number) {
    return action(async () => {
        await requireUser();
        await db
            .update(novel)
            .set({ status: "running", statusMessage: "Resuming…", stopRequested: false, failStreak: 0 })
            .where(eq(novel.id, novelId));
        await logEvent(db, novelId, "info", "run resumed");
        await enqueueNovel(novelId);
        refresh(novelId);
    });
}

/** Takes queued chapters out of the run. */
export async function clearQueue(novelId: number) {
    return action(async () => {
        await requireUser();
        const [n] = await db.select({ status: novel.status }).from(novel).where(eq(novel.id, novelId));
        if (n?.status === "running") throw new Error("Pause the run first");
        const rows = await db
            .update(chapter)
            .set({ status: "new" })
            .where(and(eq(chapter.novelId, novelId), inArray(chapter.status, ["queued", "translating"])))
            .returning({ id: chapter.id });
        await db.update(novel).set({ status: "idle", statusMessage: "" }).where(eq(novel.id, novelId));
        refresh(novelId);
        return { ok: true as const, message: `${rows.length} chapters removed from the queue` };
    });
}
