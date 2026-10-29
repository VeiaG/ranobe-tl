"use server";

import { and, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TERM_TYPES, TermMatcher, normalizeTerm, type Gender } from "@ranobe-tl/core";
import { db } from "@/db";
import { chapter, ignoredTerm, novel, term, termChange, termGender } from "@/db/schema";
import { logEvent } from "@/server/activity";
import { decide, type DecisionInput } from "@/server/decisions";
import { PgGlossaryStore } from "@/server/glossary-store";
import { enqueueNovel, requestSync } from "@/server/queue";
import { requireUser } from "@/server/session";
import { action } from "./util";

const TermSchema = z.object({
    source: z.string().trim().min(1, "Source term is required"),
    target: z.string().trim().min(1, "Translation is required"),
    type: z.enum(TERM_TYPES),
    note: z.string().trim().default(""),
    locked: z.boolean().default(false),
    gender: z.enum(["m", "f", "unknown"]).optional(),
    /** Chapter the gender applies from; replaces the whole gender history when changed. */
    genderFrom: z.number().int().min(1).optional(),
});
export type TermInput = z.input<typeof TermSchema>;

function refresh(novelId: number) {
    revalidatePath(`/novels/${novelId}`, "layout");
    void requestSync(novelId);
}

export async function saveTerm(novelId: number, termId: number | null, input: TermInput) {
    return action(async () => {
        const user = await requireUser();
        const data = TermSchema.parse(input);
        const store = new PgGlossaryStore(db, novelId);
        if (termId === null) {
            if (await store.findTerm(data.source)) throw new Error(`"${data.source}" is already in the glossary`);
            const t = await store.insertTerm({
                source: data.source,
                target: data.target,
                type: data.type,
                note: data.note,
                locked: data.locked,
                firstChapter: null,
                gender: data.type === "person" ? (data.gender ?? "unknown") : undefined,
            });
            await logEvent(db, novelId, "info", `term added by ${user.name}: ${t.source} → ${t.target}`);
        } else {
            const before = await store.getTerm(termId);
            if (!before) throw new Error("Term not found");
            await db
                .update(term)
                .set({ source: data.source, sourceNorm: normalizeTerm(data.source), target: data.target, type: data.type, note: data.note, locked: data.locked })
                .where(and(eq(term.id, termId), eq(term.novelId, novelId)));
            if (before.target !== data.target) {
                await db.insert(termChange).values({
                    novelId,
                    termId,
                    field: "target",
                    oldValue: before.target,
                    newValue: data.target,
                    reason: "edited by hand",
                    status: "applied",
                    decidedAt: new Date(),
                    decidedBy: user.id,
                });
            }
            if (data.gender && data.type === "person") {
                const from = data.genderFrom ?? 1;
                if (from <= 1) await db.delete(termGender).where(eq(termGender.termId, termId));
                await store.setGender(termId, from, data.gender as Gender);
            }
        }
        refresh(novelId);
    });
}

export async function deleteTerms(novelId: number, ids: number[]) {
    return action(async () => {
        await requireUser();
        await db.delete(term).where(and(eq(term.novelId, novelId), inArray(term.id, ids.length ? ids : [-1])));
        refresh(novelId);
    });
}

export async function setLocked(novelId: number, ids: number[], locked: boolean) {
    return action(async () => {
        await requireUser();
        await db
            .update(term)
            .set({ locked })
            .where(and(eq(term.novelId, novelId), inArray(term.id, ids.length ? ids : [-1])));
        refresh(novelId);
    });
}

/** Translated chapters whose source mentions these terms. */
export async function affectedChapters(novelId: number, termIds: number[]) {
    return action(async () => {
        await requireUser();
        const terms = await db
            .select()
            .from(term)
            .where(and(eq(term.novelId, novelId), inArray(term.id, termIds.length ? termIds : [-1])));
        const matcher = new TermMatcher<number>();
        for (const t of terms) matcher.add(t.source, t.id, ["person", "place", "organization"].includes(t.type));
        const chapters = await db
            .select({ index: chapter.index, source: chapter.source })
            .from(chapter)
            .where(and(eq(chapter.novelId, novelId), eq(chapter.status, "done")));
        return chapters.filter((c) => matcher.find(c.source).length > 0).map((c) => c.index);
    });
}

/** Queues chapters for another translation, e.g. after a term changed. */
export async function retranslate(novelId: number, indexes: number[]) {
    return action(async () => {
        await requireUser();
        if (!indexes.length) throw new Error("No chapters selected");
        const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
        if (!n) throw new Error("Novel not found");
        if (!n.providerKeyId) throw new Error("Choose an API key in the novel settings first");
        await db
            .update(chapter)
            .set({ status: "queued", draft: null })
            .where(and(eq(chapter.novelId, novelId), inArray(chapter.index, indexes)));
        if (n.status !== "running") {
            await db.update(novel).set({ status: "running", statusMessage: "Starting…", stopRequested: false, failStreak: 0 }).where(eq(novel.id, novelId));
            await enqueueNovel(novelId);
        }
        await logEvent(db, novelId, "info", `${indexes.length} chapters queued for re-translation`);
        refresh(novelId);
        return { ok: true as const, message: `${indexes.length} chapters queued` };
    });
}

export async function decideChange(input: Omit<DecisionInput, "userId">) {
    return action(async () => {
        const user = await requireUser();
        const res = await decide(db, { ...input, userId: user.id });
        revalidatePath("/", "layout");
        return res;
    });
}

export async function termHistory(novelId: number, termId: number) {
    return action(async () => {
        await requireUser();
        const rows = await db
            .select()
            .from(termChange)
            .where(and(eq(termChange.novelId, novelId), eq(termChange.termId, termId)));
        return rows
            .sort((a, b) => b.id - a.id)
            .map((c) => ({
                id: c.id,
                field: c.field,
                oldValue: c.oldValue,
                newValue: c.newValue,
                chapter: c.chapter,
                reason: c.reason,
                evidence: c.evidence,
                status: c.status,
                createdAt: c.createdAt.toISOString(),
            }));
    });
}

/** Lets the model propose a source again after it was removed as "not a term". */
export async function unignore(novelId: number, sourceNorm: string) {
    return action(async () => {
        await requireUser();
        await db.delete(ignoredTerm).where(and(eq(ignoredTerm.novelId, novelId), eq(ignoredTerm.sourceNorm, sourceNorm)));
        refresh(novelId);
    });
}
