import { normalizeTerm } from "./normalize.js";

export type Gender = "m" | "f" | "unknown";
export const TERM_TYPES = ["person", "place", "organization", "technique", "item", "rank", "creature", "other"] as const;
export type TermType = (typeof TERM_TYPES)[number];

export interface GenderEntry {
    fromChapter: number;
    gender: Gender;
}

export interface Term {
    id: number;
    source: string;
    target: string;
    type: TermType;
    note: string;
    locked: boolean;
    firstChapter: number | null;
    genders: GenderEntry[];
}

export type ChangeStatus = "applied" | "pending" | "rejected";
export type ChangeField = "target" | "gender";

export interface Change {
    id: number;
    termId: number;
    source: string;
    field: ChangeField;
    oldValue: string;
    newValue: string;
    chapter: number | null;
    evidence: string;
    reason: string;
    status: ChangeStatus;
    createdAt: string;
}

export interface NewTerm {
    source: string;
    target: string;
    type: TermType;
    note?: string;
    locked?: boolean;
    firstChapter: number | null;
    gender?: Gender;
}

export type NewChange = Omit<Change, "id" | "createdAt" | "source">;

/** Glossary of one novel. Implementations: Postgres in the app, in-memory for tests. */
export interface GlossaryStore {
    allTerms(): Promise<Term[]>;
    /** Lookup by normalized source (case, quotes, dashes and spacing ignored). */
    findTerm(source: string): Promise<Term | undefined>;
    getTerm(id: number): Promise<Term | undefined>;
    insertTerm(t: NewTerm): Promise<Term>;
    updateTerm(id: number, fields: Partial<Pick<Term, "target" | "type" | "note" | "locked">>): Promise<void>;
    deleteTerm(id: number): Promise<void>;
    setGender(termId: number, fromChapter: number, gender: Gender): Promise<void>;
    /** Replaces every "unknown" entry, used when the gender becomes known. */
    resolveUnknownGender(termId: number, gender: Gender): Promise<void>;

    addChange(c: NewChange): Promise<number>;
    listChanges(status?: ChangeStatus): Promise<Change[]>;
    hasChange(termId: number, field: ChangeField, newValue: string, status: ChangeStatus): Promise<boolean>;
    setChangeStatus(id: number, status: ChangeStatus): Promise<void>;
}

/** Gender valid for a chapter; before the first entry the earliest known one is used. */
export function genderAt(term: Term, chapter: number): Gender | undefined {
    if (!term.genders.length) return undefined;
    let result = term.genders[0].gender;
    for (const g of term.genders) {
        if (g.fromChapter <= chapter) result = g.gender;
    }
    return result;
}

/** In-memory store for tests and one-off tools. */
export class MemoryGlossaryStore implements GlossaryStore {
    private terms = new Map<number, Omit<Term, "genders">>();
    private genders = new Map<number, GenderEntry[]>();
    private changes: Omit<Change, "source">[] = [];
    private nextId = 1;

    async allTerms(): Promise<Term[]> {
        return [...this.terms.keys()].map((id) => this.read(id)!);
    }

    async findTerm(source: string): Promise<Term | undefined> {
        const norm = normalizeTerm(source);
        for (const t of this.terms.values()) if (normalizeTerm(t.source) === norm) return this.read(t.id);
        return undefined;
    }

    async getTerm(id: number): Promise<Term | undefined> {
        return this.read(id);
    }

    async insertTerm(t: NewTerm): Promise<Term> {
        if (await this.findTerm(t.source)) throw new Error(`term already exists: ${t.source}`);
        const id = this.nextId++;
        this.terms.set(id, {
            id,
            source: t.source,
            target: t.target,
            type: t.type,
            note: t.note ?? "",
            locked: !!t.locked,
            firstChapter: t.firstChapter,
        });
        if (t.gender) await this.setGender(id, t.firstChapter ?? 1, t.gender);
        return this.read(id)!;
    }

    async updateTerm(id: number, fields: Partial<Pick<Term, "target" | "type" | "note" | "locked">>): Promise<void> {
        const t = this.terms.get(id);
        if (!t) return;
        for (const [k, v] of Object.entries(fields)) if (v !== undefined) (t as any)[k] = v;
    }

    async deleteTerm(id: number): Promise<void> {
        this.terms.delete(id);
        this.genders.delete(id);
        this.changes = this.changes.filter((c) => c.termId !== id);
    }

    async setGender(termId: number, fromChapter: number, gender: Gender): Promise<void> {
        const list = (this.genders.get(termId) ?? []).filter((g) => g.fromChapter !== fromChapter);
        list.push({ fromChapter, gender });
        list.sort((a, b) => a.fromChapter - b.fromChapter);
        this.genders.set(termId, list);
    }

    async resolveUnknownGender(termId: number, gender: Gender): Promise<void> {
        for (const g of this.genders.get(termId) ?? []) if (g.gender === "unknown") g.gender = gender;
    }

    async addChange(c: NewChange): Promise<number> {
        const id = this.nextId++;
        this.changes.push({ ...c, id, createdAt: new Date().toISOString() });
        return id;
    }

    async listChanges(status?: ChangeStatus): Promise<Change[]> {
        return this.changes
            .filter((c) => !status || c.status === status)
            .map((c) => ({ ...c, source: this.terms.get(c.termId)?.source ?? "" }));
    }

    async hasChange(termId: number, field: ChangeField, newValue: string, status: ChangeStatus): Promise<boolean> {
        return this.changes.some((c) => c.termId === termId && c.field === field && c.newValue === newValue && c.status === status);
    }

    async setChangeStatus(id: number, status: ChangeStatus): Promise<void> {
        const c = this.changes.find((c) => c.id === id);
        if (c) c.status = status;
    }

    private read(id: number): Term | undefined {
        const t = this.terms.get(id);
        return t ? { ...t, genders: (this.genders.get(id) ?? []).map((g) => ({ ...g })) } : undefined;
    }
}
