import { and, asc, eq, inArray } from "drizzle-orm";
import {
    normalizeTerm,
    type Change,
    type ChangeField,
    type ChangeStatus,
    type Gender,
    type GenderEntry,
    type GlossaryStore,
    type NewChange,
    type NewTerm,
    type Term,
    type TermType,
} from "@ranobe-tl/core";
import type { DB } from "@/db";
import { term, termChange, termGender } from "@/db/schema";

type TermRow = typeof term.$inferSelect;

/** Glossary of one novel in Postgres. */
export class PgGlossaryStore implements GlossaryStore {
    constructor(
        private db: DB,
        private novelId: number
    ) {}

    async allTerms(): Promise<Term[]> {
        const rows = await this.db.select().from(term).where(eq(term.novelId, this.novelId)).orderBy(asc(term.id));
        return this.withGenders(rows);
    }

    async findTerm(source: string): Promise<Term | undefined> {
        const rows = await this.db
            .select()
            .from(term)
            .where(and(eq(term.novelId, this.novelId), eq(term.sourceNorm, normalizeTerm(source))));
        return (await this.withGenders(rows))[0];
    }

    async getTerm(id: number): Promise<Term | undefined> {
        const rows = await this.db
            .select()
            .from(term)
            .where(and(eq(term.novelId, this.novelId), eq(term.id, id)));
        return (await this.withGenders(rows))[0];
    }

    async insertTerm(t: NewTerm): Promise<Term> {
        const [row] = await this.db
            .insert(term)
            .values({
                novelId: this.novelId,
                source: t.source,
                sourceNorm: normalizeTerm(t.source),
                target: t.target,
                type: t.type,
                note: t.note ?? "",
                locked: !!t.locked,
                firstChapter: t.firstChapter,
            })
            .returning();
        if (t.gender) await this.setGender(row.id, t.firstChapter ?? 1, t.gender);
        return (await this.getTerm(row.id))!;
    }

    async updateTerm(id: number, fields: Partial<Pick<Term, "target" | "type" | "note" | "locked">>): Promise<void> {
        const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        if (!Object.keys(set).length) return;
        await this.db
            .update(term)
            .set(set)
            .where(and(eq(term.novelId, this.novelId), eq(term.id, id)));
    }

    async deleteTerm(id: number): Promise<void> {
        await this.db.delete(term).where(and(eq(term.novelId, this.novelId), eq(term.id, id)));
    }

    async setGender(termId: number, fromChapter: number, gender: Gender): Promise<void> {
        await this.db
            .insert(termGender)
            .values({ termId, fromChapter, gender })
            .onConflictDoUpdate({ target: [termGender.termId, termGender.fromChapter], set: { gender } });
    }

    async resolveUnknownGender(termId: number, gender: Gender): Promise<void> {
        await this.db
            .update(termGender)
            .set({ gender })
            .where(and(eq(termGender.termId, termId), eq(termGender.gender, "unknown")));
    }

    async addChange(c: NewChange): Promise<number> {
        const [row] = await this.db
            .insert(termChange)
            .values({ ...c, novelId: this.novelId, decidedAt: c.status === "pending" ? null : new Date() })
            .returning({ id: termChange.id });
        return row.id;
    }

    async listChanges(status?: ChangeStatus): Promise<Change[]> {
        const rows = await this.db
            .select({ change: termChange, source: term.source })
            .from(termChange)
            .innerJoin(term, eq(term.id, termChange.termId))
            .where(and(eq(termChange.novelId, this.novelId), status ? eq(termChange.status, status) : undefined))
            .orderBy(asc(termChange.id));
        return rows.map(({ change: c, source }) => ({
            id: c.id,
            termId: c.termId,
            source,
            field: c.field as ChangeField,
            oldValue: c.oldValue,
            newValue: c.newValue,
            chapter: c.chapter,
            evidence: c.evidence,
            reason: c.reason,
            status: c.status as ChangeStatus,
            createdAt: c.createdAt.toISOString(),
        }));
    }

    async hasChange(termId: number, field: ChangeField, newValue: string, status: ChangeStatus): Promise<boolean> {
        const rows = await this.db
            .select({ id: termChange.id })
            .from(termChange)
            .where(
                and(
                    eq(termChange.termId, termId),
                    eq(termChange.field, field),
                    eq(termChange.newValue, newValue),
                    eq(termChange.status, status)
                )
            )
            .limit(1);
        return rows.length > 0;
    }

    async setChangeStatus(id: number, status: ChangeStatus): Promise<void> {
        await this.db
            .update(termChange)
            .set({ status, decidedAt: status === "pending" ? null : new Date() })
            .where(and(eq(termChange.novelId, this.novelId), eq(termChange.id, id)));
    }

    private async withGenders(rows: TermRow[]): Promise<Term[]> {
        if (!rows.length) return [];
        const genders = new Map<number, GenderEntry[]>();
        const ids = rows.map((r) => r.id);
        const genderRows = await this.db
            .select()
            .from(termGender)
            .where(inArray(termGender.termId, ids))
            .orderBy(asc(termGender.fromChapter));
        for (const g of genderRows) {
            const list = genders.get(g.termId) ?? [];
            list.push({ fromChapter: g.fromChapter, gender: g.gender as Gender });
            genders.set(g.termId, list);
        }
        return rows.map((r) => ({
            id: r.id,
            source: r.source,
            target: r.target,
            type: r.type as TermType,
            note: r.note,
            locked: r.locked,
            firstChapter: r.firstChapter,
            genders: genders.get(r.id) ?? [],
        }));
    }
}
