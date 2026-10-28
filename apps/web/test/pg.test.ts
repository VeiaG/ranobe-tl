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
