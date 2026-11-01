import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import { chapter } from "@/db/schema";
import { diffText, diffWords, trimSame, type Hunk, type Segment } from "@/lib/diff";
import { keepVersion } from "./versions";

// The assistant's draft: a copy of the novel's chapters in an SQLite file, one per conversation.
// The assistant reads and edits the draft only (SQL and literal edits); the user reviews the difference
// and applies what they want to the real chapters. The draft cannot reach the app's database, other
// novels, keys or users, and protects itself: rows cannot be added or removed, only the translated
// title and text of translated chapters can change. The model's SQL runs in a child process that is
// killed after a timeout (a worker thread cannot be stopped while SQLite runs).

const DIR = process.env.ASSISTANT_DRAFTS_DIR || path.join(tmpdir(), "ranobe-assistant");
/** Drafts not touched for this long are deleted. */
const MAX_AGE_MS = 24 * 3600_000;
const MAX_ROWS = 300;
const MAX_CELL = 400;
const TIMEOUT_MS = 20_000;

type Sqlite = typeof import("node:sqlite");
// loaded at run time: the bundler does not need to know node:sqlite
const sqlite = () => process.getBuiltinModule("node:sqlite") as Sqlite;

export const ChatId = z.string().regex(/^[\w-]{1,80}$/, "Not a valid chat id");

function draftPath(novelId: number, chatId: string): string {
    return path.join(DIR, `${novelId}-${ChatId.parse(chatId)}.sqlite`);
}

const SCHEMA = `
CREATE TABLE chapters(chapter INTEGER PRIMARY KEY, status TEXT NOT NULL, title TEXT, source_title TEXT NOT NULL, text TEXT, source TEXT NOT NULL);
-- the chapters as they were when the draft was made (or last applied): what the changes are measured against
CREATE TABLE base(chapter INTEGER PRIMARY KEY, title TEXT, text TEXT);
CREATE TRIGGER chapters_no_insert BEFORE INSERT ON chapters BEGIN SELECT RAISE(ABORT, 'chapters cannot be added'); END;
CREATE TRIGGER chapters_no_delete BEFORE DELETE ON chapters BEGIN SELECT RAISE(ABORT, 'chapters cannot be deleted; set the text instead'); END;
CREATE TRIGGER chapters_fixed BEFORE UPDATE OF chapter, status, source_title, source ON chapters BEGIN SELECT RAISE(ABORT, 'only title and text can change'); END;
CREATE TRIGGER chapters_translated BEFORE UPDATE OF title, text ON chapters WHEN OLD.status <> 'done' BEGIN SELECT RAISE(ABORT, 'a chapter that is not translated cannot be edited'); END;
CREATE TRIGGER chapters_not_null BEFORE UPDATE OF title, text ON chapters WHEN NEW.title IS NULL OR NEW.text IS NULL OR trim(NEW.text) = '' BEGIN SELECT RAISE(ABORT, 'title and text cannot be empty'); END;
`;
const BASE_LOCK = `
CREATE TRIGGER base_no_insert BEFORE INSERT ON base BEGIN SELECT RAISE(ABORT, 'base is read-only'); END;
CREATE TRIGGER base_no_update BEFORE UPDATE ON base BEGIN SELECT RAISE(ABORT, 'base is read-only'); END;
CREATE TRIGGER base_no_delete BEFORE DELETE ON base BEGIN SELECT RAISE(ABORT, 'base is read-only'); END;
`;
const BASE_UNLOCK = "DROP TRIGGER base_no_insert; DROP TRIGGER base_no_update; DROP TRIGGER base_no_delete;";

function open(file: string) {
    const db = new (sqlite().DatabaseSync)(file);
    db.exec("PRAGMA busy_timeout = 10000");
    return db;
}

function cleanup() {
    try {
        for (const f of readdirSync(DIR)) {
            const p = path.join(DIR, f);
            if (Date.now() - statSync(p).mtimeMs > MAX_AGE_MS) rmSync(p, { force: true });
        }
    } catch {
        // nothing to clean
    }
}

const creating = new Map<string, Promise<string>>();

/** The draft of a conversation; made from the chapters as they are now on first use. */
export function ensureDraft(db: DB, novelId: number, chatId: string): Promise<string> {
    const file = draftPath(novelId, chatId);
    try {
        if (statSync(file).isFile()) return Promise.resolve(file);
    } catch {
        // not made yet
    }
    let p = creating.get(file);
    if (!p) {
        p = (async () => {
            mkdirSync(DIR, { recursive: true });
            cleanup();
            const rows = await db
                .select({ index: chapter.index, status: chapter.status, title: chapter.title, sourceTitle: chapter.sourceTitle, content: chapter.content, source: chapter.source })
                .from(chapter)
                .where(eq(chapter.novelId, novelId))
                .orderBy(asc(chapter.index));
            const tmp = `${file}.${process.pid}.tmp`;
            rmSync(tmp, { force: true });
            const d = open(tmp);
            try {
                d.exec(SCHEMA);
                const ins = d.prepare("INSERT INTO chapters VALUES (?, ?, ?, ?, ?, ?)");
                const base = d.prepare("INSERT INTO base VALUES (?, ?, ?)");
                // inserting goes before the triggers that forbid it
                d.exec("DROP TRIGGER chapters_no_insert; BEGIN");
                for (const r of rows) {
                    ins.run(r.index, r.status, r.title, r.sourceTitle, r.content, r.source);
                    base.run(r.index, r.title, r.content);
                }
                d.exec("COMMIT");
                d.exec("CREATE TRIGGER chapters_no_insert BEFORE INSERT ON chapters BEGIN SELECT RAISE(ABORT, 'chapters cannot be added'); END;");
                d.exec(BASE_LOCK);
            } finally {
                d.close();
            }
            renameSync(tmp, file);
            return file;
        })().finally(() => creating.delete(file));
        creating.set(file, p);
    }
    return p;
}

export interface DraftRow {
    index: number;
    status: string;
    title: string | null;
    content: string | null;
    source: string;
    sourceTitle: string;
}

/** Chapters of the draft, as the search and read tools see them. */
export async function draftRows(db: DB, novelId: number, chatId: string, opts: { from?: number; to?: number; only?: number } = {}): Promise<DraftRow[]> {
    const d = open(await ensureDraft(db, novelId, chatId));
    try {
        const where = opts.only !== undefined ? "WHERE chapter = ?" : "WHERE chapter BETWEEN ? AND ?";
        const args = opts.only !== undefined ? [opts.only] : [opts.from ?? -1e9, opts.to ?? 1e9];
        return d
            .prepare(`SELECT chapter AS "index", status, title, text AS content, source, source_title AS sourceTitle FROM chapters ${where} ORDER BY chapter`)
            .all(...args) as unknown as DraftRow[];
    } finally {
        d.close();
    }
}

// ---- the model's SQL ----

export const SqlInput = z.object({
    sql: z.string().min(1).max(4000).describe("One SQLite statement: SELECT (or WITH … SELECT) to look, UPDATE chapters SET title/text … to change the draft"),
});

export const SQL_TABLE = `chapters(chapter INTEGER, status TEXT, title TEXT, source_title TEXT, text TEXT, source TEXT)
- chapter: chapter number; status: new | queued | translating | done | failed | skipped
- title, text: the translated title and text (NULL when not translated); only these two can be changed, only in chapters with status 'done'
- source_title, source: the original title (may be empty: the source's first line is usually the title) and text
- extra functions: x REGEXP 'pattern' (JavaScript regex, unicode, case-sensitive), regexp_i(pattern, x) (case-insensitive),
  regexp_replace(x, pattern, replacement[, flags]) (JavaScript replace, flags default "gu"; $1, $& in the replacement),
  first_line(x), rest_lines(x) (x without its first non-empty line, trimmed), latin_share(x) (0..1: share of Latin letters among all letters)`;

/** Statements that would reach outside the draft or change its structure. */
const FORBIDDEN = /\b(attach|detach|vacuum|pragma|create|drop|alter|insert|delete|reindex|analyze|begin|commit|rollback|savepoint|release|load_extension)\b|\breplace\s+into\b|\bupdate\s+base\b/;

export function checkSql(sql: string): { error: string } | { update: boolean } {
    // literals and comments may say anything
    const code = sql
        .replace(/'(?:[^']|'')*'/g, "''")
        .replace(/--[^\n]*/g, " ")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .toLowerCase();
    if (!/^\s*(with|select|update)\b/.test(code)) return { error: "Only SELECT (or WITH … SELECT) and UPDATE chapters are allowed" };
    if (/;\s*\S/.test(code)) return { error: "One statement at a time" };
    const bad = code.match(FORBIDDEN);
    if (bad) return { error: `"${bad[0]}" is not allowed: only SELECT and UPDATE chapters` };
    // SQLite has no UPDATE inside a SELECT: the word means the statement is an update
    const update = /\bupdate\b/.test(code);
    if (update && !/\bupdate\s+(or\s+\w+\s+)?["`[]?chapters\b/.test(code)) return { error: "Only the table chapters can be updated" };
    return { update };
}

// Runs in the child process; plain CommonJS so it needs no bundling. Input on stdin, the result on stdout.
const CHILD = `
const { DatabaseSync } = require("node:sqlite");
const send = (m) => process.stdout.write(JSON.stringify(m));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
try {
    const { file, sql, update, maxRows, maxCell } = JSON.parse(input);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec("PRAGMA hard_heap_limit = 536870912");
    const cache = new Map();
    const re = (p, flags) => {
        const key = flags + "/" + p;
        if (!cache.has(key)) cache.set(key, new RegExp(p, flags));
        return cache.get(key);
    };
    const firstIdx = (x) => String(x).split("\\n").findIndex((l) => l.trim());
    db.function("regexp", { deterministic: true }, (p, x) => (x == null ? null : re(String(p), "u").test(String(x)) ? 1 : 0));
    db.function("regexp_i", { deterministic: true }, (p, x) => (x == null ? null : re(String(p), "iu").test(String(x)) ? 1 : 0));
    db.function("regexp_replace", { deterministic: true, varargs: true }, (x, p, r, flags) =>
        x == null ? null : String(x).replace(re(String(p), flags == null ? "gu" : String(flags)), String(r ?? ""))
    );
    db.function("first_line", { deterministic: true }, (x) => {
        if (x == null) return null;
        const i = firstIdx(x);
        return i < 0 ? "" : String(x).split("\\n")[i].trim();
    });
    db.function("rest_lines", { deterministic: true }, (x) => {
        if (x == null) return null;
        const lines = String(x).split("\\n");
        const i = firstIdx(x);
        return i < 0 ? "" : lines.slice(i + 1).join("\\n").trim();
    });
    db.function("latin_share", { deterministic: true }, (x) => {
        if (x == null) return null;
        const letters = String(x).match(/\\p{L}/gu) || [];
        if (!letters.length) return 0;
        return letters.filter((l) => /\\p{Script=Latin}/u.test(l)).length / letters.length;
    });
    const stmt = db.prepare(sql);
    if (update) {
        const r = stmt.run();
        send({ ok: true, changed: Number(r.changes) });
        return;
    }
    const out = [];
    let total = 0;
    for (const row of stmt.iterate()) {
        total++;
        if (out.length < maxRows) {
            const r = {};
            for (const [k, v] of Object.entries(row)) r[k] = typeof v === "string" && v.length > maxCell ? v.slice(0, maxCell) + "…" : typeof v === "bigint" ? Number(v) : v;
            out.push(r);
        }
    }
    send({ ok: true, rows: out, total });
} catch (error) {
    send({ ok: false, error: error && error.message ? error.message : String(error) });
}
});
`;

export type SqlResult =
    | { rows: Record<string, unknown>[]; totalRows: number; truncated: boolean }
    | { updated: number; chaptersChangedInDraft: number }
    | { error: string };

/** Runs the model's statement on the draft. Errors come back as a result the model can fix. */
export async function runSql(db: DB, novelId: number, chatId: string, input: z.infer<typeof SqlInput>): Promise<SqlResult> {
    const check = checkSql(input.sql);
    if ("error" in check) return check;
    const file = await ensureDraft(db, novelId, chatId);
    const result = await new Promise<{ ok: true; rows?: Record<string, unknown>[]; total?: number; changed?: number } | { ok: false; error: string }>((resolve) => {
        const child = spawn(process.execPath, ["--no-warnings", "-e", CHILD], { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        let settled = false;
        const done = (r: Parameters<typeof resolve>[0]) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill("SIGKILL");
            resolve(r);
        };
        const timer = setTimeout(() => done({ ok: false, error: `The statement took longer than ${TIMEOUT_MS / 1000} s and was stopped (an UPDATE that was stopped changed nothing)` }), TIMEOUT_MS);
        child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
        child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
        child.on("error", (error) => done({ ok: false, error: error.message }));
        child.on("close", () => {
            try {
                done(JSON.parse(out));
            } catch {
                done({ ok: false, error: `The query process failed: ${err.trim().slice(-500) || "no output"}` });
            }
        });
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify({ file, sql: input.sql, update: check.update, maxRows: MAX_ROWS, maxCell: MAX_CELL }));
    });
    if (!result.ok) return { error: result.error };
    if (result.changed !== undefined) return { updated: result.changed, chaptersChangedInDraft: (await changedChapters(file)).length };
    return { rows: result.rows!, totalRows: result.total!, truncated: result.total! > result.rows!.length };
}

// ---- literal edits ----

export const Edit = z.object({
    chapter: z.number().int(),
    field: z.enum(["title", "text"]).default("text"),
    find: z.string().min(1).describe("Exact text as it is now in the chapter, copied from a search hit or the chapter text"),
    replace: z.string().describe("What it becomes; may be empty"),
});
export type Edit = z.infer<typeof Edit>;

export const EditInput = z.object({
    edits: z.array(Edit).min(1).max(200),
});

const count = (text: string, find: string) => (find ? text.split(find).length - 1 : 0);

/** Applies literal edits to the draft, in order; each replaces every occurrence in that field. */
export async function editDraft(db: DB, novelId: number, chatId: string, edits: Edit[]) {
    const file = await ensureDraft(db, novelId, chatId);
    const d = open(file);
    const results: { chapter: number; field: string; find: string; occurrences: number; error?: string }[] = [];
    try {
        const get = d.prepare("SELECT status, title, text FROM chapters WHERE chapter = ?");
        const set = d.prepare("UPDATE chapters SET title = ?, text = ? WHERE chapter = ?");
        d.exec("BEGIN");
        for (const e of edits) {
            const r = get.get(e.chapter) as { status: string; title: string | null; text: string | null } | undefined;
            const res = { chapter: e.chapter, field: e.field, find: e.find, occurrences: 0 };
            if (!r) results.push({ ...res, error: `There is no chapter ${e.chapter}` });
            else if (r.status !== "done") results.push({ ...res, error: `Chapter ${e.chapter} is not translated` });
            else {
                const text = (e.field === "title" ? r.title : r.text) ?? "";
                const n = count(text, e.find);
                if (!n) results.push({ ...res, error: "This text is not in the chapter (copy it exactly from a search hit or the chapter)" });
                else if (e.find === e.replace) results.push({ ...res, error: "The replacement is the same text" });
                else {
                    const next = text.split(e.find).join(e.replace).trim();
                    try {
                        set.run(e.field === "title" ? next : r.title, e.field === "text" ? next : r.text, e.chapter);
                        results.push({ ...res, occurrences: n });
                    } catch (error) {
                        results.push({ ...res, error: error instanceof Error ? error.message : String(error) });
                    }
                }
            }
        }
        d.exec("COMMIT");
    } finally {
        d.close();
    }
    return { results, chaptersChangedInDraft: (await changedChapters(file)).length };
}

// ---- review ----

async function changedChapters(file: string): Promise<number[]> {
    const d = open(file);
    try {
        return (
            d.prepare("SELECT c.chapter FROM chapters c JOIN base b USING (chapter) WHERE c.title IS NOT b.title OR c.text IS NOT b.text ORDER BY c.chapter").all() as { chapter: number }[]
        ).map((r) => r.chapter);
    } finally {
        d.close();
    }
}

/** Puts chapters of the draft back as they were (all changed chapters when none are given). */
export async function revertDraft(db: DB, novelId: number, chatId: string, chapters?: number[]) {
    const file = await ensureDraft(db, novelId, chatId);
    const d = open(file);
    try {
        const sql = "UPDATE chapters SET title = b.title, text = b.text FROM base b WHERE b.chapter = chapters.chapter AND (chapters.title IS NOT b.title OR chapters.text IS NOT b.text)";
        // the not-empty trigger must not stop putting back a chapter as it was
        d.exec("DROP TRIGGER chapters_not_null; BEGIN");
        if (chapters) {
            const one = d.prepare(`${sql} AND chapters.chapter = ?`);
            for (const c of chapters) one.run(c);
        } else d.exec(sql);
        d.exec(
            "COMMIT; CREATE TRIGGER chapters_not_null BEFORE UPDATE OF title, text ON chapters WHEN NEW.title IS NULL OR NEW.text IS NULL OR trim(NEW.text) = '' BEGIN SELECT RAISE(ABORT, 'title and text cannot be empty'); END;"
        );
    } finally {
        d.close();
    }
    return { chaptersChangedInDraft: (await changedChapters(file)).length };
}

export interface DraftChange {
    chapter: number;
    title: { before: string; after: string; segments: Segment[] } | null;
    hunks: Hunk[];
    moreHunks: number;
    /** The chapter changed outside the draft since it was copied: applying would overwrite that. */
    conflict: boolean;
}

/** What applying the draft would change, chapter by chapter. */
export async function draftChanges(db: DB, novelId: number, chatId: string): Promise<{ changes: DraftChange[]; total: number }> {
    const file = draftPath(novelId, chatId);
    try {
        statSync(file);
    } catch {
        return { changes: [], total: 0 };
    }
    const d = open(file);
    let rows: { chapter: number; title: string; text: string; baseTitle: string | null; baseText: string | null }[];
    try {
        rows = d
            .prepare(
                "SELECT c.chapter, c.title, c.text, b.title AS baseTitle, b.text AS baseText FROM chapters c JOIN base b USING (chapter) WHERE c.title IS NOT b.title OR c.text IS NOT b.text ORDER BY c.chapter"
            )
            .all() as typeof rows;
    } finally {
        d.close();
    }
    const live = rows.length
        ? await db
              .select({ index: chapter.index, title: chapter.title, content: chapter.content, status: chapter.status })
              .from(chapter)
              .where(and(eq(chapter.novelId, novelId), inArray(chapter.index, rows.map((r) => r.chapter))))
        : [];
    const byIndex = new Map(live.map((l) => [l.index, l]));
    const changes = rows.slice(0, 500).map((r): DraftChange => {
        const l = byIndex.get(r.chapter);
        const conflict = !l || l.status !== "done" || l.title !== r.baseTitle || l.content !== r.baseText;
        const before = { title: r.baseTitle ?? "", text: r.baseText ?? "" };
        const text = diffText(before.text, r.text, 40);
        return {
            chapter: r.chapter,
            title: before.title !== r.title ? { before: before.title, after: r.title, segments: diffWords(before.title, r.title) } : null,
            hunks: text.hunks.map((h) => ({ ...h, lines: h.lines.map((l) => trimSame(l)) })),
            moreHunks: text.more,
            conflict,
        };
    });
    return { changes, total: rows.length };
}

/**
 * Writes the chosen chapters of the draft to the real chapters. A chapter changed outside the draft since it
 * was copied is not overwritten. Applied chapters become the new base of the draft.
 */
export async function applyDraft(db: DB, novelId: number, chatId: string, chapters: number[]) {
    const file = draftPath(novelId, chatId);
    const d = open(file);
    const applied: number[] = [];
    const skipped: { chapter: number; reason: string }[] = [];
    try {
        const get = d.prepare("SELECT c.title, c.text, b.title AS baseTitle, b.text AS baseText FROM chapters c JOIN base b USING (chapter) WHERE c.chapter = ?");
        const rebase = d.prepare("UPDATE base SET title = ?, text = ? WHERE chapter = ?");
        for (const index of chapters) {
            const r = get.get(index) as { title: string; text: string; baseTitle: string | null; baseText: string | null } | undefined;
            if (!r || (r.title === r.baseTitle && r.text === r.baseText)) {
                skipped.push({ chapter: index, reason: "nothing to apply" });
                continue;
            }
            const [c] = await db
                .select()
                .from(chapter)
                .where(and(eq(chapter.novelId, novelId), eq(chapter.index, index)));
            if (!c || c.status !== "done" || c.title !== r.baseTitle || c.content !== r.baseText) {
                skipped.push({ chapter: index, reason: "the chapter changed since the draft was made (translated or edited again)" });
                continue;
            }
            await keepVersion(db, c, "assistant");
            await db.update(chapter).set({ title: r.title.trim(), content: r.text.trim() }).where(eq(chapter.id, c.id));
            d.exec(BASE_UNLOCK);
            rebase.run(r.title.trim(), r.text.trim(), index);
            d.exec(BASE_LOCK);
            // the draft holds the text exactly as it was saved
            d.prepare("UPDATE chapters SET title = ?, text = ? WHERE chapter = ?").run(r.title.trim(), r.text.trim(), index);
            applied.push(index);
        }
    } finally {
        d.close();
    }
    return { applied, skipped };
}
