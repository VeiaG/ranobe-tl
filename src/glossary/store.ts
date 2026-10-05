import { DatabaseSync } from "node:sqlite";
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

export interface Change {
    id: number;
    termId: number;
    source: string;
    field: "target" | "gender";
    oldValue: string;
    newValue: string;
    chapter: number | null;
    evidence: string;
    reason: string;
    status: ChangeStatus;
    createdAt: string;
}

export interface ChapterRecord {
    index: number;
    status: "done" | "failed" | "skipped";
    model: string;
    attempts: number;
    ratio: number | null;
    error: string;
    updatedAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS terms (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    source_norm TEXT NOT NULL UNIQUE,
    target TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'other',
    note TEXT NOT NULL DEFAULT '',
    locked INTEGER NOT NULL DEFAULT 0,
    first_chapter INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS genders (
    term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    from_chapter INTEGER NOT NULL,
    gender TEXT NOT NULL,
    PRIMARY KEY (term_id, from_chapter)
);
CREATE TABLE IF NOT EXISTS changes (
    id INTEGER PRIMARY KEY,
    term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
    field TEXT NOT NULL,
    old_value TEXT NOT NULL,
    new_value TEXT NOT NULL,
    chapter INTEGER,
    evidence TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chapters (
    idx INTEGER PRIMARY KEY,
    status TEXT NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    ratio REAL,
    error TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

type Row = Record<string, any>;

export class GlossaryStore {
    private db: DatabaseSync;

    constructor(file: string) {
        this.db = new DatabaseSync(file);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        this.db.exec(SCHEMA);
    }

    close(): void {
        this.db.close();
    }

    transaction<T>(fn: () => T): T {
        this.db.exec("BEGIN");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (e) {
            this.db.exec("ROLLBACK");
            throw e;
        }
    }

    // ---------- terms ----------

    allTerms(): Term[] {
        const genders = new Map<number, GenderEntry[]>();
        for (const g of this.db.prepare("SELECT * FROM genders ORDER BY from_chapter").all() as Row[]) {
            const list = genders.get(g.term_id) ?? [];
            list.push({ fromChapter: g.from_chapter, gender: g.gender });
            genders.set(g.term_id, list);
        }
        return (this.db.prepare("SELECT * FROM terms ORDER BY id").all() as Row[]).map((r) =>
            toTerm(r, genders.get(r.id) ?? [])
        );
    }

    findTerm(source: string): Term | undefined {
        const row = this.db.prepare("SELECT * FROM terms WHERE source_norm = ?").get(normalizeTerm(source)) as Row | undefined;
        return row ? this.withGenders(row) : undefined;
    }

    getTerm(id: number): Term | undefined {
        const row = this.db.prepare("SELECT * FROM terms WHERE id = ?").get(id) as Row | undefined;
        return row ? this.withGenders(row) : undefined;
    }

    insertTerm(t: {
        source: string;
        target: string;
        type: TermType;
        note?: string;
        locked?: boolean;
        firstChapter: number | null;
        gender?: Gender;
    }): Term {
        const res = this.db
            .prepare(
                "INSERT INTO terms (source, source_norm, target, type, note, locked, first_chapter) VALUES (?, ?, ?, ?, ?, ?, ?)"
            )
            .run(t.source, normalizeTerm(t.source), t.target, t.type, t.note ?? "", t.locked ? 1 : 0, t.firstChapter);
        const id = Number(res.lastInsertRowid);
        if (t.gender) this.setGender(id, t.firstChapter ?? 1, t.gender);
        return this.getTerm(id)!;
    }

    updateTerm(id: number, fields: Partial<Pick<Term, "target" | "type" | "note" | "locked">>): void {
        const sets: string[] = [];
        const values: (string | number)[] = [];
        if (fields.target !== undefined) (sets.push("target = ?"), values.push(fields.target));
        if (fields.type !== undefined) (sets.push("type = ?"), values.push(fields.type));
        if (fields.note !== undefined) (sets.push("note = ?"), values.push(fields.note));
        if (fields.locked !== undefined) (sets.push("locked = ?"), values.push(fields.locked ? 1 : 0));
        if (!sets.length) return;
        this.db.prepare(`UPDATE terms SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
    }

    deleteTerm(id: number): void {
        this.db.prepare("DELETE FROM terms WHERE id = ?").run(id);
    }

    setGender(termId: number, fromChapter: number, gender: Gender): void {
        this.db
            .prepare("INSERT OR REPLACE INTO genders (term_id, from_chapter, gender) VALUES (?, ?, ?)")
            .run(termId, fromChapter, gender);
    }

    /** Replaces every "unknown" entry, used when the gender becomes known. */
    resolveUnknownGender(termId: number, gender: Gender): void {
        this.db.prepare("UPDATE genders SET gender = ? WHERE term_id = ? AND gender = 'unknown'").run(gender, termId);
    }

    // ---------- changes ----------

    addChange(c: Omit<Change, "id" | "createdAt" | "source">): number {
        const res = this.db
            .prepare(
                "INSERT INTO changes (term_id, field, old_value, new_value, chapter, evidence, reason, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .run(c.termId, c.field, c.oldValue, c.newValue, c.chapter, c.evidence, c.reason, c.status);
        return Number(res.lastInsertRowid);
    }

    listChanges(status?: ChangeStatus): Change[] {
        const sql =
            "SELECT c.*, t.source FROM changes c JOIN terms t ON t.id = c.term_id" +
            (status ? " WHERE c.status = ?" : "") +
            " ORDER BY c.id";
        const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as Row[];
        return rows.map(toChange);
    }

    getChange(id: number): Change | undefined {
        const row = this.db
            .prepare("SELECT c.*, t.source FROM changes c JOIN terms t ON t.id = c.term_id WHERE c.id = ?")
            .get(id) as Row | undefined;
        return row ? toChange(row) : undefined;
    }

    hasPendingChange(termId: number, field: string, newValue: string): boolean {
        return !!this.db
            .prepare("SELECT 1 FROM changes WHERE term_id = ? AND field = ? AND new_value = ? AND status = 'pending'")
            .get(termId, field, newValue);
    }

    setChangeStatus(id: number, status: ChangeStatus): void {
        this.db.prepare("UPDATE changes SET status = ? WHERE id = ?").run(status, id);
    }

    // ---------- chapters ----------

    saveChapter(r: Omit<ChapterRecord, "updatedAt">): void {
        this.db
            .prepare(
                `INSERT INTO chapters (idx, status, model, attempts, ratio, error, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
                 ON CONFLICT(idx) DO UPDATE SET status = excluded.status, model = excluded.model,
                 attempts = excluded.attempts, ratio = excluded.ratio, error = excluded.error, updated_at = excluded.updated_at`
            )
            .run(r.index, r.status, r.model, r.attempts, r.ratio, r.error);
    }

    listChapters(status?: ChapterRecord["status"]): ChapterRecord[] {
        const sql = "SELECT * FROM chapters" + (status ? " WHERE status = ?" : "") + " ORDER BY idx";
        const rows = (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all()) as Row[];
        return rows.map((r) => ({
            index: r.idx,
            status: r.status,
            model: r.model,
            attempts: r.attempts,
            ratio: r.ratio,
            error: r.error,
            updatedAt: r.updated_at,
        }));
    }

    private withGenders(row: Row): Term {
        const genders = (
            this.db.prepare("SELECT * FROM genders WHERE term_id = ? ORDER BY from_chapter").all(row.id) as Row[]
        ).map((g) => ({ fromChapter: g.from_chapter, gender: g.gender }));
        return toTerm(row, genders);
    }
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

function toTerm(r: Row, genders: GenderEntry[]): Term {
    return {
        id: r.id,
        source: r.source,
        target: r.target,
        type: r.type,
        note: r.note,
        locked: !!r.locked,
        firstChapter: r.first_chapter,
        genders,
    };
}

function toChange(r: Row): Change {
    return {
        id: r.id,
        termId: r.term_id,
        source: r.source,
        field: r.field,
        oldValue: r.old_value,
        newValue: r.new_value,
        chapter: r.chapter,
        evidence: r.evidence,
        reason: r.reason,
        status: r.status,
        createdAt: r.created_at,
    };
}
