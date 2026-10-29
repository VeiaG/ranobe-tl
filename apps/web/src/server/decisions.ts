import { and, asc, count, eq, inArray } from "drizzle-orm";
import type { ChangeField, Gender, TermType } from "@ranobe-tl/core";
import type { DB } from "@/db";
import { chapter, novel, term, termChange, termGender } from "@/db/schema";
import { logEvent } from "./activity";
import { PgGlossaryStore } from "./glossary-store";
import { enqueueNovel, requestSync } from "./queue";

export interface DecisionInput {
    novelId: number;
    termId: number;
    field: ChangeField;
    /** The change whose value to apply; null keeps the current value (all pending proposals are rejected). */
    useChangeId?: number | null;
    /** A value typed by the user instead of any proposal (translations only). */
    custom?: string | null;
    lock?: boolean;
    userId?: string | null;
    /** New terms only: "not a term", delete it and drop future proposals of it. */
    remove?: boolean;
    /** New terms only: fix what the model got wrong while reviewing. */
    type?: TermType;
    gender?: Gender;
}

export interface DecisionResult {
    applied: string | null;
    term: string;
    resumed: boolean;
    /** The term was removed as "not a term". */
    removed?: boolean;
}

/**
 * Review of a new term (ask-new). The term is already in the glossary, so "keep" accepts it as it is;
 * a custom value replaces the translation; "remove" deletes it and ignores the source from now on.
 */
async function decideNew(db: DB, input: DecisionInput) {
    return db.transaction(async (tx) => {
        const store = new PgGlossaryStore(tx as unknown as DB, input.novelId);
        const t = await store.getTerm(input.termId);
        if (!t) throw new Error("term not found");
        const decided = { decidedAt: new Date(), decidedBy: input.userId ?? null };

        if (input.remove) {
            await store.ignore(t.source);
            await store.deleteTerm(t.id);
            return { applied: null, term: t.source, removed: true };
        }
        await tx
            .update(termChange)
            .set({ status: "applied", ...decided })
            .where(and(eq(termChange.termId, t.id), eq(termChange.field, "new"), eq(termChange.status, "pending")));

        const custom = input.custom?.trim() || null;
        const type = input.type ?? (t.type as TermType);
        await tx
            .update(term)
            .set({ ...(custom ? { target: custom } : {}), type, ...(input.lock ? { locked: true } : {}) })
            .where(eq(term.id, t.id));
        if (custom && custom !== t.target) {
            await tx.insert(termChange).values({
                novelId: input.novelId,
                termId: t.id,
                field: "target",
                oldValue: t.target,
                newValue: custom,
                chapter: t.firstChapter,
                reason: "set while reviewing the new term",
                status: "applied",
                ...decided,
            });
        }
        if (type === "person" && input.gender) {
            // the review sets the gender for the whole history of a term this new
            await tx.delete(termGender).where(eq(termGender.termId, t.id));
            await store.setGender(t.id, t.firstChapter ?? 1, input.gender);
        } else if (type !== "person" && t.genders.length) {
            await tx.delete(termGender).where(eq(termGender.termId, t.id));
        }
        return { applied: custom ?? t.target, term: t.source, removed: false };
    });
}

/** Decides every pending proposal for one term and field at once, then resumes a novel waiting on them. */
export async function decide(db: DB, input: DecisionInput): Promise<DecisionResult> {
    if (input.field === "new") {
        const res = await decideNew(db, input);
        await requestSync(input.novelId);
        await logEvent(db, input.novelId, "info", res.removed ? `${res.term}: removed, not a term` : `${res.term} → ${res.applied}: new term confirmed`);
        return { ...res, resumed: await resumeIfDecided(db, input.novelId) };
    }
    const result = await db.transaction(async (tx) => {
        const [t] = await tx
            .select()
            .from(term)
            .where(and(eq(term.id, input.termId), eq(term.novelId, input.novelId)));
        if (!t) throw new Error("term not found");

        const pending = await tx
            .select()
            .from(termChange)
            .where(and(eq(termChange.termId, t.id), eq(termChange.field, input.field), eq(termChange.status, "pending")))
            .orderBy(asc(termChange.id));

        const chosen = input.useChangeId ? pending.find((c) => c.id === input.useChangeId) : undefined;
        if (input.useChangeId && !chosen) throw new Error("this proposal was already decided");
        const custom = input.field === "target" ? input.custom?.trim() || null : null;
        const value = custom ?? chosen?.newValue ?? null;
        const now = new Date();
        const decided = { decidedAt: now, decidedBy: input.userId ?? null };

        for (const c of pending) {
            const applied = !custom && value !== null && c.newValue === value;
            await tx
                .update(termChange)
                .set({ status: applied ? "applied" : "rejected", ...decided })
                .where(eq(termChange.id, c.id));
        }

        if (value !== null) {
            if (input.field === "target") {
                await tx.update(term).set({ target: value }).where(eq(term.id, t.id));
                if (custom) {
                    await tx.insert(termChange).values({
                        novelId: input.novelId,
                        termId: t.id,
                        field: "target",
                        oldValue: t.target,
                        newValue: custom,
                        chapter: null,
                        reason: "set by hand",
                        status: "applied",
                        ...decided,
                    });
                }
            } else {
                const from = pending.find((c) => c.newValue === value)?.chapter ?? 1;
                await new PgGlossaryStore(tx as unknown as DB, input.novelId).setGender(t.id, from, value as Gender);
            }
        }
        if (input.lock) await tx.update(term).set({ locked: true }).where(eq(term.id, t.id));
        return { applied: value, term: t.source };
    });

    const what = input.field === "target" ? "translation" : "gender";
    await logEvent(
        db,
        input.novelId,
        "info",
        result.applied === null ? `${result.term}: kept the current ${what}` : `${result.term}: ${what} → ${result.applied}`
    );
    await requestSync(input.novelId);
    const resumed = await resumeIfDecided(db, input.novelId);
    return { ...result, resumed };
}

/**
 * A novel in "waiting" stopped on a chapter because of proposals made in it.
 * Once they are all decided, the chapter goes back into the run (translated again with the new glossary).
 */
export async function resumeIfDecided(db: DB, novelId: number): Promise<boolean> {
    const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
    if (!n || n.status !== "waiting") return false;
    const [next] = await db
        .select({ index: chapter.index })
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), inArray(chapter.status, ["queued", "translating"])))
        .orderBy(asc(chapter.index))
        .limit(1);
    if (next) {
        const [{ left }] = await db
            .select({ left: count() })
            .from(termChange)
            .where(and(eq(termChange.novelId, novelId), eq(termChange.status, "pending"), eq(termChange.chapter, next.index)));
        if (left > 0) return false;
    }
    await db.update(novel).set({ status: "running", statusMessage: "" }).where(eq(novel.id, novelId));
    await logEvent(db, novelId, "info", "all decisions made, translation resumes");
    await enqueueNovel(novelId);
    return true;
}

/** Pending proposals grouped by term and field, oldest first. */
export async function pendingGroups(db: DB, novelId?: number) {
    const rows = await db
        .select({ change: termChange, term, novelTitle: novel.title })
        .from(termChange)
        .innerJoin(term, eq(term.id, termChange.termId))
        .innerJoin(novel, eq(novel.id, termChange.novelId))
        .where(and(eq(termChange.status, "pending"), novelId ? eq(termChange.novelId, novelId) : undefined))
        .orderBy(asc(termChange.id));
    // latest known gender per term, for showing and fixing it during review
    const genders = new Map<number, string>();
    const termIds = [...new Set(rows.map((r) => r.term.id))];
    if (termIds.length) {
        const g = await db.select().from(termGender).where(inArray(termGender.termId, termIds)).orderBy(asc(termGender.fromChapter));
        for (const row of g) genders.set(row.termId, row.gender);
    }
    const groups = new Map<
        string,
        { novelId: number; novelTitle: string; term: typeof term.$inferSelect; gender: string | null; field: ChangeField; changes: (typeof termChange.$inferSelect)[] }
    >();
    for (const r of rows) {
        const key = `${r.term.id}:${r.change.field}`;
        const g = groups.get(key) ?? {
            novelId: r.change.novelId,
            novelTitle: r.novelTitle,
            term: r.term,
            gender: genders.get(r.term.id) ?? null,
            field: r.change.field as ChangeField,
            changes: [],
        };
        g.changes.push(r.change);
        groups.set(key, g);
    }
    return [...groups.values()];
}
export type PendingGroup = Awaited<ReturnType<typeof pendingGroups>>[number];
