import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { genderAt } from "@ranobe-tl/core";

// Needs a Postgres: DATABASE_URL=postgres://… pnpm test. Skipped otherwise.
// The Anthropic Message Batches API is played by a local server: every request is answered by `respond`.
const enabled = !!process.env.DATABASE_URL;

let db: typeof import("@/db").db;
let schema: typeof import("@/db/schema");
let server: Server;
let novelId = 0;
let keyId = 0;
const chapterIds = new Map<number, number>();

type Params = { messages: { content: string | { text: string }[] }[]; system: { text: string }[] };
/** Requests sent without a batch (POST /v1/messages). */
const direct: Params[] = [];
const batches = new Map<string, { custom_id: string; params: Params }[]>();
const sent: { custom_id: string; params: Params }[] = [];

function respond(customId: string, params: Params): string {
    const content = params.messages[0].content;
    const prompt = typeof content === "string" ? content : content.map((p) => p.text).join("");
    const source = prompt.match(/<source>\n([\s\S]*)\n<\/source>/)![1];
    if (customId.startsWith("e-")) {
        const terms = [{ source: "Saintess", target: "Свята", type: "rank", gender: "f", note: "a title" }];
        // chapter 3 spells the hero differently: a conflict to settle by hand
        if (source.includes("Zhao Yun")) terms.push({ source: "Zhao Yun", target: source.includes("third") ? "Джао Юнь" : "Чжао Юнь", type: "person", gender: "m", note: "the hero" });
        return `[${terms.map((t) => JSON.stringify(t)).join(",")}]`;
    }
    // the first attempt at the chunk marked FAILME comes back untranslated
    if (source.includes("FAILME") && !prompt.includes("IMPORTANT: your previous attempt")) return `<translation>\n${source}\n</translation>`;
    // never good enough: a summary of the source
    if (source.includes("TOOSHORT")) return `<title>Розділ 4</title>\n<translation>\nКоротко.\n</translation>`;
    const body = "Переклад тексту. ".repeat(Math.ceil(source.length / 17)).slice(0, source.length);
    return `<title>Розділ</title>\n<translation>\n${body}\n</translation>`;
}

function batchObject(id: string, ended: boolean, port: number) {
    const n = batches.get(id)!.length;
    return {
        id,
        type: "message_batch",
        processing_status: ended ? "ended" : "in_progress",
        request_counts: { processing: ended ? 0 : n, succeeded: ended ? n : 0, errored: 0, canceled: 0, expired: 0 },
        results_url: ended ? `http://127.0.0.1:${port}/v1/messages/batches/${id}/results` : null,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
        ended_at: ended ? new Date().toISOString() : null,
        cancel_initiated_at: null,
        archived_at: null,
    };
}

before(async () => {
    if (!enabled) return;
    process.env.APP_SECRET ??= "test-secret-0123456789";
    server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            const port = (server.address() as { port: number }).port;
            const url = req.url ?? "";
            res.setHeader("content-type", "application/json");
            if (req.method === "POST" && url === "/v1/messages/batches") {
                const id = `msgbatch_${batches.size + 1}`;
                const requests = JSON.parse(body).requests;
                batches.set(id, requests);
                sent.push(...requests);
                return res.end(JSON.stringify(batchObject(id, false, port)));
            }
            const results = url.match(/^\/v1\/messages\/batches\/([^/]+)\/results$/);
            if (results) {
                res.setHeader("content-type", "application/binary");
                const lines = batches.get(results[1])!.map((r) => ({
                    custom_id: r.custom_id,
                    result: {
                        type: "succeeded",
                        message: {
                            id: `msg_${r.custom_id}`,
                            type: "message",
                            role: "assistant",
                            model: "claude-haiku-5-5",
                            content: [{ type: "text", text: respond(r.custom_id, r.params) }],
                            stop_reason: "end_turn",
                            stop_sequence: null,
                            usage: { input_tokens: 900, output_tokens: 400, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
                        },
                    },
                }));
                return res.end(lines.map((l) => JSON.stringify(l)).join("\n"));
            }
            const one = url.match(/^\/v1\/messages\/batches\/([^/]+)$/);
            if (one) return res.end(JSON.stringify(batchObject(one[1], true, port)));
            if (req.method === "POST" && url === "/v1/messages") {
                const params = JSON.parse(body);
                direct.push(params);
                return res.end(
                    JSON.stringify({
                        id: "msg_direct",
                        type: "message",
                        role: "assistant",
                        model: params.model,
                        content: [{ type: "text", text: respond("t-direct", params) }],
                        stop_reason: "end_turn",
                        stop_sequence: null,
                        usage: { input_tokens: 800, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
                    })
                );
            }
            res.statusCode = 404;
            res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: url } }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;

    const { runMigrations } = await import("@/db/migrate");
    await runMigrations();
    ({ db } = await import("@/db"));
    schema = await import("@/db/schema");
    const { encrypt } = await import("@/lib/crypto");
    const [key] = await db
        .insert(schema.providerKey)
        .values({ name: `test ${Date.now()}`, provider: "anthropic", baseURL: `http://127.0.0.1:${port}/v1`, encryptedKey: encrypt("sk-ant-test"), hint: "test" })
        .returning();
    keyId = key.id;
    const [n] = await db
        .insert(schema.novel)
        .values({ title: `batch test ${Date.now()}`, pipeline: "batch", providerKeyId: key.id, model: "claude-haiku-5-5", settings: { validation: { minSourceChars: 10 } } })
        .returning();
    novelId = n.id;
    const sources = [
        "Chapter 1\n\nZhao Yun met the Saintess at the gate. He bowed and the Saintess smiled at him, then walked on.",
        "Chapter 2\n\nThe Saintess prayed alone in the hall. FAILME The candles burned low while she waited for the dawn.",
        "Chapter 3\n\nOn the third day Zhao Yun left the mountain and the Saintess watched him go from the high wall.",
    ];
    for (const [i, source] of sources.entries()) {
        const [ch] = await db.insert(schema.chapter).values({ novelId, index: i + 1, sourceTitle: `Chapter ${i + 1}`, source }).returning();
        chapterIds.set(i + 1, ch.id);
    }
});

after(async () => {
    if (!enabled) return;
    await db.delete(schema.novel).where(eq(schema.novel.id, novelId));
    await db.delete(schema.providerKey).where(eq(schema.providerKey.id, keyId));
    server.close();
    const { getBoss } = await import("@/server/queue");
    await (await getBoss()).stop({ graceful: false }).catch(() => {});
    process.exit(0);
});

const silent = { async finished() {}, async chapterFailed() {}, async runHalted() {} };

async function lastJob() {
    const jobs = await db.select().from(schema.batchJob).where(eq(schema.batchJob.novelId, novelId));
    return jobs.sort((a, b) => b.id - a.id)[0];
}

test("batch: extraction merges what agrees and leaves conflicts", { skip: !enabled }, async () => {
    const { submitExtraction } = await import("@/server/batch/submit");
    const { pollBatch } = await import("@/server/batch/ingest");
    const { candidateGroups } = await import("@/server/batch/merge");
    const { PgGlossaryStore } = await import("@/server/glossary-store");

    assert.equal(await submitExtraction(db, novelId, { kind: "missing" }), 3);
    const job = await lastJob();
    assert.equal(job.kind, "extract");
    assert.equal(job.requests, 3);
    assert.match(sent[0].params.system[0].text, /Titles and ranks/);
    const [running] = await db.select().from(schema.novel).where(eq(schema.novel.id, novelId));
    assert.equal(running.status, "running");

    await pollBatch(db, job.id, silent);
    const store = new PgGlossaryStore(db, novelId);
    // a title held by a woman is added once, as a rank without gender
    const saintess = (await store.findTerm("Saintess"))!;
    assert.equal(saintess.target, "Свята");
    assert.equal(saintess.type, "rank");
    assert.deepEqual(saintess.genders, []);
    // two spellings of the hero: nothing added, one group to settle
    assert.equal(await store.findTerm("Zhao Yun"), undefined);
    const groups = await candidateGroups(db, novelId);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].source, "Zhao Yun");
    assert.deepEqual(groups[0].variants.map((v) => [v.target, v.count]), [["Чжао Юнь", 1], ["Джао Юнь", 1]]);

    const chapters = await db.select().from(schema.chapter).where(eq(schema.chapter.novelId, novelId));
    assert.ok(chapters.every((c) => c.extractedAt));
    const usage = await db.select().from(schema.usageRecord).where(eq(schema.usageRecord.novelId, novelId));
    assert.equal(usage.length, 3);
    assert.ok(usage.every((u) => u.model === "claude-haiku-5-5:batch" && u.inputTokens === 1000 && u.cachedTokens === 100));
    const [idle] = await db.select().from(schema.novel).where(eq(schema.novel.id, novelId));
    assert.equal(idle.status, "idle");
});

test("batch: a merged choice goes to the glossary", { skip: !enabled }, async () => {
    const { acceptGroup, candidateGroups, groupSnippets } = await import("@/server/batch/merge");
    const { PgGlossaryStore } = await import("@/server/glossary-store");
    const [group] = await candidateGroups(db, novelId);
    const snippets = await groupSnippets(db, novelId, group.key);
    assert.deepEqual(snippets.map((s) => [s.chapter, s.match]), [[1, "Zhao Yun"], [3, "Zhao Yun"]]);

    await acceptGroup(db, novelId, group.key, { target: "Чжао Юнь", type: "person", note: "the hero", gender: "m" });
    const zhao = (await new PgGlossaryStore(db, novelId).findTerm("Zhao Yun"))!;
    assert.equal(zhao.target, "Чжао Юнь");
    assert.equal(zhao.firstChapter, 1);
    assert.equal(genderAt(zhao, 3), "m");
    assert.equal((await candidateGroups(db, novelId)).length, 0);
});

test("batch: translation with the glossary, a rejected chunk goes out again", { skip: !enabled }, async () => {
    const { submitTranslation } = await import("@/server/batch/submit");
    const { pollBatch } = await import("@/server/batch/ingest");
    sent.length = 0;

    const res = await submitTranslation(db, novelId, undefined);
    assert.deepEqual(res, { chapters: 3, skipped: 0 });
    const first = sent.find((r) => r.custom_id === `t-${chapterIds.get(1)}-0-1`)!;
    assert.match(String(first.params.messages[0].content), /Zhao Yun → Чжао Юнь \[person, m, the hero\]/);
    assert.match(first.params.system[0].text, /put them in the gender of the person who holds them/);
    assert.doesNotMatch(first.params.system[0].text, /<terms>/);

    await pollBatch(db, (await lastJob()).id, silent);
    const ch = async (index: number) =>
        (await db.select().from(schema.chapter).where(and(eq(schema.chapter.novelId, novelId), eq(schema.chapter.index, index))))[0];
    assert.equal((await ch(1)).status, "done");
    assert.equal((await ch(3)).status, "done");
    assert.equal((await ch(1)).title, "Розділ");
    // chapter 2 came back in English: it goes out again with the reason
    const two = await ch(2);
    assert.equal(two.status, "translating");
    assert.equal(two.batchState!.attempts[0], 1);
    const retry = await lastJob();
    assert.equal(retry.requests, 1);
    const again = sent.find((r) => r.custom_id === `t-${chapterIds.get(2)}-0-2`)!;
    assert.match(String(again.params.messages[0].content), /IMPORTANT: your previous attempt was rejected: too much untranslated/);

    await pollBatch(db, retry.id, silent);
    const done = await ch(2);
    assert.equal(done.status, "done");
    assert.equal(done.attempts, 2);
    assert.equal(done.batchState, null);
    const [n] = await db.select().from(schema.novel).where(eq(schema.novel.id, novelId));
    assert.equal(n.status, "idle");

    const { spent } = await import("@/server/budget");
    const { usd } = await spent(db, eq(schema.usageRecord.novelId, novelId));
    // 3 extractions + 4 translations at half the Haiku price: 900 uncached + 100 cached in, 400 out
    const one = (900 * 0.1 + 100 * 0.01 + 400 * 0.5) / 1_000_000 / 2;
    assert.ok(Math.abs(usd - 7 * one) < 1e-9, `spent ${usd}`);
});

test("batch: results being applied are not applied twice; left over at start, they fail", { skip: !enabled }, async () => {
    const { pollBatch, failInterrupted } = await import("@/server/batch/ingest");
    const chapterId = chapterIds.get(3)!;
    await db.update(schema.chapter).set({ status: "translating" }).where(eq(schema.chapter.id, chapterId));
    const [job] = await db
        .insert(schema.batchJob)
        .values({ novelId, kind: "translate", externalId: "msgbatch_1", keyId, model: "claude-haiku-5-5", chapterIds: [chapterId], requests: 1, status: "applying" })
        .returning();
    const usage = async () => (await db.select().from(schema.usageRecord).where(eq(schema.usageRecord.novelId, novelId))).length;
    const before = await usage();

    await pollBatch(db, job.id, silent);
    assert.equal(await usage(), before, "a poll of a batch being applied does nothing");
    assert.equal((await db.select().from(schema.batchJob).where(eq(schema.batchJob.id, job.id)))[0].status, "applying");

    await failInterrupted(db, job.id, silent);
    assert.equal((await db.select().from(schema.batchJob).where(eq(schema.batchJob.id, job.id)))[0].status, "failed");
    const [ch] = await db.select().from(schema.chapter).where(eq(schema.chapter.id, chapterId));
    assert.equal(ch.status, "failed");
    assert.match(ch.error, /worker stopped while applying/);
    const [n] = await db.select().from(schema.novel).where(eq(schema.novel.id, novelId));
    assert.equal(n.status, "error");
});

test("batch: a few chapters are translated right away, without a batch", { skip: !enabled }, async () => {
    const { submitTranslation } = await import("@/server/batch/submit");
    const { translateDirect } = await import("@/server/batch/direct");
    const { inArray } = await import("drizzle-orm");
    await db.update(schema.novel).set({ status: "idle" }).where(eq(schema.novel.id, novelId));
    const jobsBefore = (await db.select().from(schema.batchJob).where(eq(schema.batchJob.novelId, novelId))).length;

    // chapter 2: the first attempt comes back in English, the second is fine
    const res = await submitTranslation(db, novelId, and(eq(schema.chapter.novelId, novelId), inArray(schema.chapter.index, [2])), { direct: true });
    assert.deepEqual(res, { chapters: 1, skipped: 0 });
    assert.equal((await db.select().from(schema.batchJob).where(eq(schema.batchJob.novelId, novelId))).length, jobsBefore, "no batch");
    const [running] = await db.select().from(schema.novel).where(eq(schema.novel.id, novelId));
    assert.equal(running.status, "running");

    await translateDirect(db, chapterIds.get(2)!, silent);
    const [ch] = await db.select().from(schema.chapter).where(eq(schema.chapter.id, chapterIds.get(2)!));
    assert.equal(ch.status, "done");
    assert.equal(ch.attempts, 2);
    assert.equal(direct.length, 2);
    assert.match(JSON.stringify(direct[1].messages), /IMPORTANT: your previous attempt was rejected/);
    const usage = await db.select().from(schema.usageRecord).where(and(eq(schema.usageRecord.novelId, novelId), eq(schema.usageRecord.model, "claude-haiku-5-5")));
    assert.deepEqual(usage.map((u) => u.ok), [false, true], "full-price requests, the rejected one marked");
    const [n] = await db.select().from(schema.novel).where(eq(schema.novel.id, novelId));
    assert.equal(n.status, "idle");
});

test("batch: every request is logged; a rejected translation can be taken anyway", { skip: !enabled }, async () => {
    const { submitTranslation } = await import("@/server/batch/submit");
    const { translateDirect } = await import("@/server/batch/direct");
    const { acceptRejected } = await import("@/server/rejected");
    const { inArray } = await import("drizzle-orm");

    // the batch requests of chapter 1 are in its log, with the output
    const log = await db.select().from(schema.exchange).where(and(eq(schema.exchange.novelId, novelId), eq(schema.exchange.chapter, 1)));
    assert.deepEqual(log.map((e) => e.chunk).sort(), [-1, 0], "extraction (-1) and translation");
    assert.ok(log.every((e) => e.prompt.includes("<source>") && e.output.length > 0));

    await db.update(schema.novel).set({ status: "idle", settings: { validation: { minSourceChars: 10 }, maxAttempts: 1 } }).where(eq(schema.novel.id, novelId));
    const [ch] = await db
        .insert(schema.chapter)
        .values({ novelId, index: 4, sourceTitle: "Chapter 4", source: "Chapter 4\n\nTOOSHORT A long passage that the model keeps summarizing into a single short line." })
        .returning();
    await submitTranslation(db, novelId, and(eq(schema.chapter.novelId, novelId), inArray(schema.chapter.index, [4])), { direct: true });
    await translateDirect(db, ch.id, silent);
    const [failed] = await db.select().from(schema.chapter).where(eq(schema.chapter.id, ch.id));
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.rejected?.parts, ["Коротко."]);
    assert.match(failed.rejected!.problems[0], /too short/);
    assert.equal((await db.select().from(schema.exchange).where(and(eq(schema.exchange.novelId, novelId), eq(schema.exchange.chapter, 4)))).length, 1);

    assert.deepEqual(await acceptRejected(db, novelId, 4), { done: true });
    const [taken] = await db.select().from(schema.chapter).where(eq(schema.chapter.id, ch.id));
    assert.equal(taken.status, "done");
    assert.equal(taken.content, "Коротко.");
    assert.equal(taken.title, "Розділ 4");
    assert.equal(taken.rejected, null);
});

test("classic: a rejected part taken anyway becomes a draft, the rest is translated by the run", { skip: !enabled }, async () => {
    const { acceptRejected } = await import("@/server/rejected");
    const { chunkText, cleanSource, parseConfig } = await import("@ranobe-tl/core");
    const [n] = await db
        .insert(schema.novel)
        .values({ title: `classic ${Date.now()}`, providerKeyId: keyId, model: "claude-haiku-5-5", settings: { chunkSize: 1000, validation: { minSourceChars: 10 } } })
        .returning();
    try {
        const source = "Chapter 1\n\n" + Array.from({ length: 30 }, (_, i) => `Paragraph ${i} with enough words to fill the chunk.`).join("\n\n");
        const chunks = chunkText(cleanSource(source, parseConfig({ chunkSize: 1000 })), 1000);
        assert.ok(chunks.length >= 2);
        await db.insert(schema.chapter).values({
            novelId: n.id,
            index: 1,
            source,
            status: "failed",
            rejected: { sources: chunks.slice(0, 1), parts: ["Перша частина."], title: "Розділ 1", problems: { 0: "loop" } },
        });
        assert.deepEqual(await acceptRejected(db, n.id, 1), { done: false });
        const [ch] = await db.select().from(schema.chapter).where(eq(schema.chapter.novelId, n.id));
        assert.equal(ch.status, "queued");
        assert.deepEqual(ch.draft, { sources: chunks.slice(0, 1), parts: ["Перша частина."], title: "Розділ 1", terms: [] });
        assert.equal(ch.rejected, null);
        const [running] = await db.select().from(schema.novel).where(eq(schema.novel.id, n.id));
        assert.equal(running.status, "running");
    } finally {
        await db.delete(schema.novel).where(eq(schema.novel.id, n.id));
    }
});
