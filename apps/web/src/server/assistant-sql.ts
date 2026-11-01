import "server-only";
import { spawn } from "node:child_process";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { DB } from "@/db";
import { chapter } from "@/db/schema";

// SQL for the assistant, without access to the app's database: the chapters of one novel are copied
// into an in-memory SQLite database in a child process. Nothing it runs can reach other novels, keys or
// users, a write only changes the throwaway copy, and a runaway query is killed with its process
// (a worker thread cannot be stopped while SQLite runs).

export const SqlInput = z.object({
    sql: z.string().min(1).max(4000).describe("One SQLite SELECT statement over the table chapters"),
});

export const SQL_TABLE = `chapters(chapter INTEGER, status TEXT, title TEXT, source_title TEXT, text TEXT, source TEXT)
- chapter: chapter number; status: new | queued | translating | done | failed | skipped
- title, text: the translated title and text (NULL when not translated)
- source_title, source: the original title (may be empty: the source's first line is usually the title) and text
- extra functions: x REGEXP 'pattern' (JavaScript regex, unicode, case-sensitive), regexp_i(pattern, x) (case-insensitive),
  first_line(x), latin_share(x) (0..1: the share of Latin letters among all letters of x)`;

const MAX_ROWS = 300;
const MAX_CELL = 400;
const TIMEOUT_MS = 15_000;

// Runs in the child process; plain CommonJS so it needs no bundling. Input on stdin, the result on stdout.
const CHILD = `
const { DatabaseSync } = require("node:sqlite");
const send = (m) => process.stdout.write(JSON.stringify(m));
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
try {
    const { rows, sql, maxRows, maxCell } = JSON.parse(input);
    const db = new DatabaseSync(":memory:");
    const cache = new Map();
    const re = (p, flags) => {
        const key = flags + p;
        if (!cache.has(key)) cache.set(key, new RegExp(p, flags));
        return cache.get(key);
    };
    db.function("regexp", { deterministic: true }, (p, x) => (x == null ? null : re(String(p), "u").test(String(x)) ? 1 : 0));
    db.function("regexp_i", { deterministic: true }, (p, x) => (x == null ? null : re(String(p), "iu").test(String(x)) ? 1 : 0));
    db.function("first_line", { deterministic: true }, (x) => (x == null ? null : (String(x).split("\\n").find((l) => l.trim()) || "").trim()));
    db.function("latin_share", { deterministic: true }, (x) => {
        if (x == null) return null;
        const letters = String(x).match(/\\p{L}/gu) || [];
        if (!letters.length) return 0;
        return letters.filter((l) => /\\p{Script=Latin}/u.test(l)).length / letters.length;
    });
    db.exec("PRAGMA hard_heap_limit = 536870912");
    db.exec("CREATE TABLE chapters(chapter INTEGER PRIMARY KEY, status TEXT, title TEXT, source_title TEXT, text TEXT, source TEXT)");
    const insert = db.prepare("INSERT INTO chapters VALUES (?, ?, ?, ?, ?, ?)");
    db.exec("BEGIN");
    for (const r of rows) insert.run(r.chapter, r.status, r.title, r.sourceTitle, r.text, r.source);
    db.exec("COMMIT");
    const stmt = db.prepare(sql);
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

export type SqlResult = { rows: Record<string, unknown>[]; totalRows: number; truncated: boolean } | { error: string };

/** Runs a read query over the chapters of one novel. Errors come back as a result the model can fix. */
export async function runSql(db: DB, novelId: number, input: z.infer<typeof SqlInput>): Promise<SqlResult> {
    if (!/^\s*(with|select)\b/i.test(input.sql)) return { error: "Only one SELECT (or WITH … SELECT) statement is allowed" };
    const rows = await db
        .select({ chapter: chapter.index, status: chapter.status, title: chapter.title, sourceTitle: chapter.sourceTitle, text: chapter.content, source: chapter.source })
        .from(chapter)
        .where(eq(chapter.novelId, novelId))
        .orderBy(asc(chapter.index));
    return new Promise((resolve) => {
        const child = spawn(process.execPath, ["--no-warnings", "-e", CHILD], { stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        let err = "";
        let settled = false;
        const done = (r: SqlResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill("SIGKILL");
            resolve(r);
        };
        const timer = setTimeout(() => done({ error: `The query took longer than ${TIMEOUT_MS / 1000} s and was stopped` }), TIMEOUT_MS);
        child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
        child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
        child.on("error", (error) => done({ error: error.message }));
        child.on("close", () => {
            try {
                const m = JSON.parse(out) as { ok: true; rows: Record<string, unknown>[]; total: number } | { ok: false; error: string };
                done(m.ok ? { rows: m.rows, totalRows: m.total, truncated: m.total > m.rows.length } : { error: m.error });
            } catch {
                done({ error: `The query process failed: ${err.trim().slice(-500) || "no output"}` });
            }
        });
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify({ rows, sql: input.sql, maxRows: MAX_ROWS, maxCell: MAX_CELL }));
    });
}
