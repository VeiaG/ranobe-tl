import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { eq } from "drizzle-orm";
import { Glossary, genderAt } from "@ranobe-tl/core";

// Needs a Postgres: DATABASE_URL=postgres://… pnpm test. Skipped otherwise.
const enabled = !!process.env.DATABASE_URL;

let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");
let novelId = 0;

before(async () => {
    if (!enabled) return;
    const { runMigrations } = await import("@/db/migrate");
    await runMigrations();
    ({ db } = await import("@/db"));
    schema = await import("@/db/schema");
    const [n] = await db.insert(schema.novel).values({ title: `test ${Date.now()}`, decisionMode: "pause", status: "waiting" }).returning();
    novelId = n.id;
});

after(async () => {
    if (!enabled) return;
    await db.delete(schema.novel).where(eq(schema.novel.id, novelId));
    const { getBoss } = await import("@/server/queue");
    await (await getBoss()).stop({ graceful: false }).catch(() => {});
    process.exit(0);
});

test("pg store: the glossary rules work on Postgres", { skip: !enabled }, async () => {
    const { PgGlossaryStore } = await import("@/server/glossary-store");
    const store = new PgGlossaryStore(db, novelId);
    const g = await Glossary.load(store);
    const src = "Zhao Yun drew the blade. She smiled coldly at the Sky Tower.";

    assert.equal((await g.propose({ source: "Zhao Yun", target: "Чжао Юнь", type: "person", gender: "m" }, 10, src))[0].kind, "added");
    assert.equal((await g.propose({ source: "Sky Tower", target: "Небесна Вежа", type: "place" }, 10, src))[0].kind, "added");
    assert.equal((await g.propose({ source: "Sky-Towers", target: "Небесні Вежі", type: "place" }, 11, src))[0].kind, "similar");
    assert.equal((await g.propose({ source: "Sky Tower", target: "Вежа Неба", type: "place" }, 12, src))[0].kind, "pending");
    assert.equal((await store.findTerm("sky tower"))!.target, "Небесна Вежа");

    const changed = await g.propose({ source: "Zhao Yun", target: "Чжао Юнь", type: "person", gender: "f", evidence: "She smiled coldly" }, 20, src);
    assert.equal(changed[0].kind, "gender-changed");
    const zhao = (await store.findTerm("Zhao Yun"))!;
    assert.equal(genderAt(zhao, 15), "m");
    assert.equal(genderAt(zhao, 25), "f");

    assert.equal((await store.listChanges("pending")).length, 1);
    assert.ok(await store.hasChange((await store.findTerm("Sky Tower"))!.id, "target", "Вежа Неба", "pending"));
});

test("decisions: applying the last proposal of the waiting chapter resumes the novel", { skip: !enabled }, async () => {
    const { decide } = await import("@/server/decisions");
    const { PgGlossaryStore } = await import("@/server/glossary-store");
    const store = new PgGlossaryStore(db, novelId);
    await db.insert(schema.chapter).values({ novelId, index: 12, source: "Chapter 12\n\nText", status: "queued" });
    const tower = (await store.findTerm("Sky Tower"))!;
    const [proposal] = await store.listChanges("pending");

    const res = await decide(db, { novelId, termId: tower.id, field: "target", useChangeId: proposal.id });
    assert.equal(res.applied, "Вежа Неба");
    assert.equal(res.resumed, true);
    assert.equal((await store.findTerm("Sky Tower"))!.target, "Вежа Неба");
    const [n] = await db.select().from(schema.novel).where(eq(schema.novel.id, novelId));
    assert.equal(n.status, "running");

    // a custom value rejects every proposal and is recorded as applied
    await store.addChange({ termId: tower.id, field: "target", oldValue: "Вежа Неба", newValue: "Вежа Небес", chapter: 13, evidence: "", reason: "", status: "pending" });
    const custom = await decide(db, { novelId, termId: tower.id, field: "target", custom: "Небесна Башта" });
    assert.equal(custom.applied, "Небесна Башта");
    const history = await store.listChanges();
    assert.equal(history.find((c) => c.newValue === "Вежа Небес")!.status, "rejected");
    assert.equal(history.at(-1)!.newValue, "Небесна Башта");
    assert.equal(history.at(-1)!.status, "applied");
});

test("upload: chapter numbers come from file names", async () => {
    const { indexFromName, splitByHeadings } = await import("@/server/import/chapters");
    assert.equal(indexFromName("00012.txt"), 12);
    assert.equal(indexFromName("Chapter 7 - Wind.txt"), 7);
    assert.equal(indexFromName("vol2/ch-031.txt"), 31);
    assert.equal(indexFromName("prologue.txt"), null);
    const parts = splitByHeadings("Chapter 1: A\n\nOne.\n\nChapter 2: B\n\nTwo.");
    assert.deepEqual(parts.map((p) => [p.index, p.source.split("\n")[0]]), [[1, "Chapter 1: A"], [2, "Chapter 2: B"]]);
});

test("decisions: reviewing new terms (confirm with fixes, or 'not a term')", { skip: !enabled }, async () => {
    const { decide } = await import("@/server/decisions");
    const { PgGlossaryStore } = await import("@/server/glossary-store");
    const store = new PgGlossaryStore(db, novelId);
    const g = await Glossary.load(store, { askNew: { types: ["person", "rank"] } });
    const src = "Elder Mo nodded. The Elder spoke.";

    assert.deepEqual((await g.propose({ source: "Elder Mo", target: "Старійшина Мо", type: "person" }, 30, src)).map((o) => o.kind), ["added", "pending"]);
    assert.deepEqual((await g.propose({ source: "Elder", target: "Старійшина", type: "rank" }, 30, src)).map((o) => o.kind), ["added", "pending"]);

    const mo = (await store.findTerm("Elder Mo"))!;
    const fixed = await decide(db, { novelId, termId: mo.id, field: "new", custom: "Старець Мо", gender: "f" });
    assert.equal(fixed.applied, "Старець Мо");
    const after = (await store.findTerm("Elder Mo"))!;
    assert.equal(after.target, "Старець Мо");
    assert.equal(genderAt(after, 1), "f");

    const elder = (await store.findTerm("Elder"))!;
    const removed = await decide(db, { novelId, termId: elder.id, field: "new", remove: true });
    assert.equal(removed.removed, true);
    assert.equal(await store.findTerm("Elder"), undefined);
    assert.ok(await store.isIgnored("elder"));
    const again = await Glossary.load(store, { askNew: {} });
    assert.equal((await again.propose({ source: "Elder", target: "Старійшина", type: "rank" }, 31, src))[0].kind, "ignored");
    assert.equal((await store.listChanges("pending")).filter((c) => c.field === "new").length, 0);
});

test("storage: a novel folder imports back with its glossary, decisions and translations", { skip: !enabled }, async () => {
    const { novelFolder } = await import("@/server/storage/folder");
    const { importNovelFolder } = await import("@/server/storage/import");
    const { PgGlossaryStore } = await import("@/server/glossary-store");
    await db.insert(schema.chapter).values({ novelId, index: 13, source: "Chapter 13: Sky\n\nText of thirteen.", sourceTitle: "Chapter 13: Sky", status: "done", title: "Розділ 13", content: "Текст." });
    await new PgGlossaryStore(db, novelId).ignore("The Elder");

    const folder = await novelFolder(db, novelId);
    assert.ok(folder.has("novel.json") && folder.has("glossary.json") && folder.has("translation/00013.json") && folder.has("chapters/00012.txt"));
    const files = new Map([...folder].map(([p, body]) => [p, new TextEncoder().encode(body)]));
    const res = await importNovelFolder(db, files, { title: "roundtrip" });
    try {
        const store = new PgGlossaryStore(db, res.novelId);
        const original = await new PgGlossaryStore(db, novelId).allTerms();
        const copy = await store.allTerms();
        assert.deepEqual(copy.map((t) => [t.source, t.target, t.type, t.locked, t.genders]), original.map((t) => [t.source, t.target, t.type, t.locked, t.genders]));
        assert.ok(await store.isIgnored("the elder"));
        assert.ok((await store.listChanges("rejected")).some((c) => c.newValue === "Вежа Небес"));
        const [c13] = await db.select().from(schema.chapter).where(eq(schema.chapter.novelId, res.novelId)).then((r) => r.filter((c) => c.index === 13));
        assert.equal(c13.status, "done");
        assert.equal(c13.content, "Текст.");
        const [n] = await db.select().from(schema.novel).where(eq(schema.novel.id, res.novelId));
        assert.equal(n.decisionMode, "pause");
    } finally {
        await db.delete(schema.novel).where(eq(schema.novel.id, res.novelId));
    }
});

test("usage: cost from the price table, budgets stop a novel", { skip: !enabled }, async () => {
    const { costOf } = await import("@/server/pricing");
    const { budgetStop, spent } = await import("@/server/budget");
    // 1M input of which 400k cached, 100k output at $4 / $0.20 / $20
    assert.equal(costOf({ inputTokens: 1_000_000, cachedTokens: 400_000, outputTokens: 100_000 }, { input: 4, cachedInput: 0.2, output: 20 })!.toFixed(2), "4.48");
    assert.equal(costOf({ inputTokens: 1, cachedTokens: 0, outputTokens: 1 }, undefined), null);

    await db.insert(schema.usageRecord).values([
        { novelId, novelTitle: "t", provider: "anthropic", model: "claude-opus-5-5", inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 0 },
        { novelId, novelTitle: "t", provider: "openai", model: "some-unpriced-model", inputTokens: 5_000_000, cachedTokens: 0, outputTokens: 0, ok: false },
    ]);
    const s = await spent(db, eq(schema.usageRecord.novelId, novelId));
    assert.equal(s.usd, 4);
    assert.deepEqual(s.unpriced, ["some-unpriced-model"]);
    assert.equal(await budgetStop(db, { id: novelId, budgetUsd: 10 }, undefined), null);
    assert.match((await budgetStop(db, { id: novelId, budgetUsd: 3 }, undefined))!, /budget reached: \$4\.00 spent of \$3\.00/);
});
