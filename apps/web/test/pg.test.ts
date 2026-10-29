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

test("instance: slots respect the global and the per-key limits", { skip: !enabled }, async () => {
    const { claimSlot, INSTANCE_KEY } = await import("@/server/instance");
    const { setSetting } = await import("@/server/settings");
    const [key] = await db.insert(schema.providerKey).values({ name: "slot-test", provider: "openai", encryptedKey: "x", hint: "x" }).returning();
    const novels = await db
        .insert(schema.novel)
        .values([1, 2, 3].map((i) => ({ title: `slots ${i}`, status: "running" as const, providerKeyId: key.id })))
        .returning();
    const chapters = await db
        .insert(schema.chapter)
        .values(novels.map((n) => ({ novelId: n.id, index: 1, source: "x", status: "queued" as const })))
        .returning();
    try {
        await setSetting(db, INSTANCE_KEY, { concurrency: 2 });
        const k = { id: key.id, name: key.name, maxParallel: null };
        const others = await db.select({ n: schema.chapter.id }).from(schema.chapter).where(eq(schema.chapter.status, "translating"));
        assert.equal(others.length, 0, "no other chapter in flight during the test");
        assert.equal((await claimSlot(db, chapters[0].id, novels[0].id, k)).ok, true);
        assert.equal((await claimSlot(db, chapters[1].id, novels[1].id, k)).ok, true);
        const third = await claimSlot(db, chapters[2].id, novels[2].id, k);
        assert.equal(third.ok, false);
        if (!third.ok) assert.match(third.reason, /2 of 2 busy/);

        await setSetting(db, INSTANCE_KEY, { concurrency: 5 });
        const limited = await claimSlot(db, chapters[2].id, novels[2].id, { ...k, maxParallel: 2 });
        assert.equal(limited.ok, false);
        if (!limited.ok) assert.match(limited.reason, /key "slot-test" \(2 of 2 busy\)/);
    } finally {
        await setSetting(db, INSTANCE_KEY, {});
        for (const n of novels) await db.delete(schema.novel).where(eq(schema.novel.id, n.id));
        await db.delete(schema.providerKey).where(eq(schema.providerKey.id, key.id));
    }
});

test("versions: replacing a translation keeps the old text, only the last ten stay", { skip: !enabled }, async () => {
    const { keepVersion, KEEP_VERSIONS } = await import("@/server/versions");
    const [c] = await db.insert(schema.chapter).values({ novelId, index: 40, source: "x", status: "done", title: "T", content: "v0" }).returning();
    await keepVersion(db, { ...c, content: null }, "translation");
    assert.equal((await db.select().from(schema.chapterVersion).where(eq(schema.chapterVersion.chapterId, c.id))).length, 0, "nothing to keep without text");
    for (let i = 0; i < KEEP_VERSIONS + 3; i++) await keepVersion(db, { ...c, content: `v${i}` }, i % 2 ? "edit" : "translation");
    const kept = await db.select().from(schema.chapterVersion).where(eq(schema.chapterVersion.chapterId, c.id));
    assert.equal(kept.length, KEEP_VERSIONS);
    assert.deepEqual(kept.map((v) => v.content).sort(), Array.from({ length: KEEP_VERSIONS }, (_, i) => `v${i + 3}`).sort());
});

test("sequels: a glossary copied from an earlier part keeps names, the last gender and rejections", { skip: !enabled }, async () => {
    const { forSequel, glossaryOfNovel, mergeGlossary } = await import("@/server/glossary-seed");
    const { PgGlossaryStore } = await import("@/server/glossary-store");
    const [sequel] = await db.insert(schema.novel).values({ title: "part two" }).returning();
    try {
        const own = new PgGlossaryStore(db, sequel.id);
        await own.insertTerm({ source: "Zhao Yun", target: "Чжао Юн (своє)", type: "person", firstChapter: 1, gender: "m" });

        const res = await mergeGlossary(db, sequel.id, forSequel(await glossaryOfNovel(db, novelId)));
        assert.ok(res.added > 0);
        assert.equal(res.existing, 1, "the sequel's own term wins");
        assert.equal((await own.findTerm("Zhao Yun"))!.target, "Чжао Юн (своє)");

        // in part one Elder Mo became "f" from chapter 30 (see above); in part two that holds from chapter 1
        const mo = (await own.findTerm("Elder Mo"))!;
        assert.deepEqual(mo.genders, [{ fromChapter: 1, gender: "f" }]);
        assert.equal(mo.firstChapter, null);
        assert.ok(await own.isIgnored("the elder"));
        assert.ok((await own.listChanges("rejected")).length > 0);
        assert.equal((await own.listChanges("pending")).length, 0, "open questions stay with part one");

        // importing again adds nothing
        const again = await mergeGlossary(db, sequel.id, forSequel(await glossaryOfNovel(db, novelId)));
        assert.equal(again.added, 0);
        assert.equal(again.rejected, 0);
    } finally {
        await db.delete(schema.novel).where(eq(schema.novel.id, sequel.id));
    }
});

test("pause: accepting every new term keeps the translated chunks, Telegram buttons close after a decision in the app", { skip: !enabled }, async () => {
    const http = await import("node:http");
    const { encrypt } = await import("@/lib/crypto");
    const { decide } = await import("@/server/decisions");
    const { DECIDED_QUEUE, getBoss } = await import("@/server/queue");
    const { translateNext } = await import("@/worker/run");
    const { createTelegram } = await import("@/worker/telegram");

    // a fake Anthropic API (the model) and a fake Telegram Bot API on one port
    const prose = (n: number) => `Лінь Фен увійшов до зали ${n} й довго роззирався навкруги, нічого не кажучи. `.repeat(18);
    let modelCalls = 0;
    let messageId = 0;
    const edits: { chat_id: string; message_id: number; text: string; reply_markup?: unknown }[] = [];
    const server = http.createServer(async (req, res) => {
        let body = "";
        for await (const part of req) body += part;
        const json = (data: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(data));
        if (req.url === "/messages") {
            modelCalls++;
            // the first chunk finds a new name
            const terms = modelCalls === 1 ? `[{"source":"Lin Feng","target":"Лінь Фен","type":"person","gender":"m"}]` : "[]";
            const text = `<title>Розділ 1</title>\n<translation>\n${prose(modelCalls)}\n</translation>\n<terms>${terms}</terms>`;
            return json({ id: "m", type: "message", role: "assistant", model: "x", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
        }
        const params = JSON.parse(body || "{}");
        if (req.url!.endsWith("/sendMessage")) return json({ ok: true, result: { message_id: ++messageId, date: 0, chat: { id: Number(params.chat_id), type: "private" }, text: params.text } });
        if (req.url!.endsWith("/editMessageText")) edits.push(params);
        return json({ ok: true, result: true });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const root = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.APP_SECRET ??= "test-secret-test-secret";
    process.env.TELEGRAM_API_ROOT = root;

    const userId = `tg-${Date.now()}`;
    await db.insert(schema.user).values({ id: userId, name: "t", email: `${userId}@example.com` });
    await db.insert(schema.telegramLink).values({ userId, chatId: "4242" });
    const [key] = await db.insert(schema.providerKey).values({ name: "pause-test", provider: "anthropic", baseURL: root, encryptedKey: encrypt("sk-test"), hint: "test" }).returning();
    const [n] = await db
        .insert(schema.novel)
        .values({ title: "pause test", status: "running", decisionMode: "pause", askNew: {}, providerKeyId: key.id, settings: { chunkSize: 1500 } })
        .returning();
    const paragraph = "Lin Feng walked into the great hall and looked around for a long while. ".repeat(20);
    await db.insert(schema.chapter).values({ novelId: n.id, index: 1, source: `Chapter 1\n\n${paragraph}\n\n${paragraph}`, status: "queued" });
    const telegram = createTelegram(db, "123:test");
    try {
        assert.equal(await translateNext(db, n.id, telegram.notifier), "stop");
        let [ch] = await db.select().from(schema.chapter).where(eq(schema.chapter.novelId, n.id));
        assert.equal(ch.status, "queued");
        assert.equal(ch.draft?.parts.length, 1, "the paused first chunk is kept");
        assert.deepEqual(ch.draft?.terms.map((t) => t.source), ["Lin Feng"]);
        const [sent] = await db.select().from(schema.telegramMessage).where(eq(schema.telegramMessage.chatId, "4242"));
        assert.ok(sent, "the decision message is remembered");

        // accepted in the app, as proposed
        const lin = (await db.select().from(schema.term).where(eq(schema.term.novelId, n.id)))[0];
        const res = await decide(db, { novelId: n.id, termId: lin.id, field: "new" });
        assert.equal(res.resumed, true);

        // the worker gets the decision and closes the Telegram message
        const boss = await getBoss();
        const jobs = await boss.fetch<import("@/server/queue").DecidedJob>(DECIDED_QUEUE, { batchSize: 50 });
        const job = jobs.find((j) => j.data.termId === lin.id);
        assert.ok(job, "a decision job was queued");
        await telegram.decided(job.data);
        assert.equal(edits.length, 1);
        assert.equal(edits[0].message_id, sent.messageId);
        assert.equal(edits[0].reply_markup, undefined, "no buttons any more");
        assert.match(edits[0].text, /confirmed → Лінь Фен/);
        assert.equal((await db.select().from(schema.telegramMessage).where(eq(schema.telegramMessage.termId, lin.id))).length, 0);

        // the run goes on from the second chunk
        assert.equal(await translateNext(db, n.id, telegram.notifier), "next");
        [ch] = await db.select().from(schema.chapter).where(eq(schema.chapter.novelId, n.id));
        assert.equal(ch.status, "done");
        assert.equal(modelCalls, 2, "the first chunk is not translated again");
        assert.match(ch.content!, /зали 1.*зали 2/s);
        assert.equal(ch.draft, null);
    } finally {
        server.close();
        delete process.env.TELEGRAM_API_ROOT;
        await db.delete(schema.novel).where(eq(schema.novel.id, n.id));
        await db.delete(schema.providerKey).where(eq(schema.providerKey.id, key.id));
        await db.delete(schema.user).where(eq(schema.user.id, userId));
        await db.delete(schema.telegramMessage).where(eq(schema.telegramMessage.chatId, "4242"));
    }
});
