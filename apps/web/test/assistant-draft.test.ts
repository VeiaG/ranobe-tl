import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { diffText, diffWords } from "@/lib/diff";

// Needs a Postgres: DATABASE_URL=postgres://… pnpm test. Skipped otherwise.
const enabled = !!process.env.DATABASE_URL;
process.env.ASSISTANT_DRAFTS_DIR = mkdtempSync(path.join(tmpdir(), "drafts-"));

let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");
let draft: typeof import("@/server/assistant-draft");
let novelId = 0;
const chat = "chat-1";

before(async () => {
    if (!enabled) return;
    const { runMigrations } = await import("@/db/migrate");
    await runMigrations();
    ({ db } = await import("@/db"));
    schema = await import("@/db/schema");
    draft = await import("@/server/assistant-draft");
    const [n] = await db.insert(schema.novel).values({ title: `draft ${Date.now()}` }).returning();
    novelId = n.id;
    await db.insert(schema.chapter).values([
        { novelId, index: 1, status: "done", source: "Chapter 1 The Boom\n\nBoom.", title: "Chapter 1 The Boom", content: "Розділ 1 Вибух\n\nБум.\n\nТяньлан пішов." },
        { novelId, index: 2, status: "done", source: "Chapter 2 Gate\n\nText.", title: "Розділ 2 Брама", content: "Тяньлана не було." },
        { novelId, index: 3, status: "new", source: "Chapter 3\n\nMore." },
    ]);
});

after(async () => {
    if (!enabled) return;
    await db.delete(schema.novel).where(eq(schema.novel.id, novelId));
    process.exit(0);
});

test("diff: words inside a changed line", () => {
    assert.deepEqual(diffWords("Тяньлан пішов.", "Тяньлань пішов."), [
        { kind: "del", text: "Тяньлан" },
        { kind: "add", text: "Тяньлань" },
        { kind: "same", text: " пішов." },
    ]);
    const d = diffText("A\n\nB\n\nC", "A\n\nB2\n\nC");
    assert.equal(d.hunks.length, 1);
    assert.equal(d.hunks[0].paragraph, 2);
    assert.equal(d.hunks[0].before, "A");
    assert.equal(d.hunks[0].after, "C");
});

test("draft: SQL checks keep the model inside the draft", { skip: !enabled }, () => {
    const bad = ["ATTACH 'x.db' AS x", "select 1; drop table chapters", "PRAGMA writable_schema=1", "delete from chapters", "update base set text = ''", "vacuum into '/tmp/x'", "insert into chapters values (1)"];
    for (const sql of bad) assert.ok("error" in draft.checkSql(sql), sql);
    assert.deepEqual(draft.checkSql("select 'drop table' from chapters -- attach"), { update: false });
    assert.deepEqual(draft.checkSql("UPDATE chapters SET title = replace(title, 'a', 'b')"), { update: true });
});

test("draft: the assistant edits the draft, the user applies it", { skip: !enabled }, async () => {
    // a title left in English with the translated one opening the text: one UPDATE
    const sel = await draft.runSql(db, novelId, chat, { sql: "select chapter, title from chapters where latin_share(title) > 0.5 and status = 'done'" });
    assert.deepEqual("rows" in sel && sel.rows, [{ chapter: 1, title: "Chapter 1 The Boom" }]);
    const upd = await draft.runSql(db, novelId, chat, { sql: "update chapters set title = first_line(text), text = rest_lines(text) where chapter = 1" });
    assert.deepEqual(upd, { updated: 1, chaptersChangedInDraft: 1 });
    // protections
    assert.ok("error" in (await draft.runSql(db, novelId, chat, { sql: "update chapters set text = 'x' where chapter = 3" })));
    assert.ok("error" in (await draft.runSql(db, novelId, chat, { sql: "update chapters set source = 'x'" })));
    assert.ok("error" in (await draft.runSql(db, novelId, chat, { sql: "update chapters set text = ''" })));
    // regexp_replace across chapters, then a literal edit
    const re = await draft.runSql(db, novelId, chat, { sql: "update chapters set text = regexp_replace(text, 'Тяньлан(\\p{L}*)', 'Тяньлань$1') where text regexp 'Тяньлан'" });
    assert.deepEqual(re, { updated: 2, chaptersChangedInDraft: 2 });
    const ed = await draft.editDraft(db, novelId, chat, [{ chapter: 2, field: "text", find: "не було", replace: "не було вдома" }, { chapter: 2, field: "text", find: "нема", replace: "x" }]);
    assert.equal(ed.results[0].occurrences, 1);
    assert.ok(ed.results[1].error);
    // the real chapters did not change yet
    const [c1] = await db.select().from(schema.chapter).where(and(eq(schema.chapter.novelId, novelId), eq(schema.chapter.index, 1)));
    assert.equal(c1.title, "Chapter 1 The Boom");

    const { changes, total } = await draft.draftChanges(db, novelId, chat);
    assert.equal(total, 2);
    assert.equal(changes[0].title?.after, "Розділ 1 Вибух");
    assert.ok(!changes[0].conflict);

    // chapter 2 changes outside the draft: applying it is refused
    await db.update(schema.chapter).set({ content: "Тяньлана не було, а тепер є." }).where(and(eq(schema.chapter.novelId, novelId), eq(schema.chapter.index, 2)));
    assert.ok((await draft.draftChanges(db, novelId, chat)).changes[1].conflict);
    const res = await draft.applyDraft(db, novelId, chat, [1, 2]);
    assert.deepEqual(res.applied, [1]);
    assert.equal(res.skipped[0].chapter, 2);
    const [a1] = await db.select().from(schema.chapter).where(and(eq(schema.chapter.novelId, novelId), eq(schema.chapter.index, 1)));
    assert.equal(a1.title, "Розділ 1 Вибух");
    assert.equal(a1.content, "Бум.\n\nТяньлань пішов.");

    // the applied chapter is the new base; discarding puts chapter 2 back
    await draft.revertDraft(db, novelId, chat, [2]);
    assert.equal((await draft.draftChanges(db, novelId, chat)).total, 0);
    const rows = await draft.draftRows(db, novelId, chat, { only: 2 });
    assert.equal(rows[0].content, "Тяньлана не було.");
});
