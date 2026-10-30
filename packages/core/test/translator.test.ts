import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { parseConfig } from "../src/config";
import { Glossary } from "../src/glossary/glossary";
import { MemoryGlossaryStore } from "../src/glossary/store";
import { Translator, type TranslatorEvent } from "../src/pipeline/translator";

const setup = (model: MockLanguageModelV3) => ({ model, providerOptions: {}, systemProviderOptions: {} });

function reply(text: string) {
    return {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
            inputTokens: { total: 100, noCache: 60, cacheRead: 40, cacheWrite: 0 },
            outputTokens: { total: 50, text: 50, reasoning: 0 },
        },
        warnings: [],
    };
}

test("translator: retries with feedback, applies terms, returns the chapter", async () => {
    const body = "Zhao Yun walked into the Sky Tower and looked around for a long while. ".repeat(20);
    const source = `Chapter 1 - Arrival\n\nChapter 1 - Arrival\n\n${body}`;

    const config = parseConfig({});
    const store = new MemoryGlossaryStore();
    await store.insertTerm({ source: "Sky Tower", target: "Небесна Вежа", type: "place", firstChapter: null });
    const glossary = await Glossary.load(store);

    const good = "Чжао Юнь увійшов до Небесної Вежі й довго роззирався навкруги, нічого не кажучи. ".repeat(18);
    const responses = [
        reply("<title>Розділ 1</title>\n<translation>\nЗанадто коротко.\n</translation>\n<terms>[]</terms>"),
        reply(
            `<title>Розділ 1 - Прибуття</title>\n<translation>\n${good}\n</translation>\n<terms>\n` +
                `[{"source":"Zhao Yun","target":"Чжао Юнь","type":"person","gender":"m"}]\n</terms>`
        ),
    ];
    const model = new MockLanguageModelV3({ doGenerate: async () => responses.shift()! });

    const events: TranslatorEvent["type"][] = [];
    const translator = new Translator(config, setup(model), glossary, { onEvent: (e) => void events.push(e.type) });
    const res = await translator.translateChapter(1, source);

    assert.equal(res.status, "done");
    if (res.status !== "done") return;
    assert.equal(model.doGenerateCalls.length, 2);

    const firstPrompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    assert.match(firstPrompt, /Sky Tower → Небесна Вежа \[place\]/);
    assert.equal((firstPrompt.match(/Chapter 1 - Arrival/g) ?? []).length, 1, "duplicated title removed");
    assert.match(JSON.stringify(model.doGenerateCalls[1].prompt), /previous attempt was rejected: translation is too short/);

    assert.equal(res.title, "Розділ 1 - Прибуття");
    assert.equal(res.content, good.trim());
    assert.deepEqual(res.usage, { input: 200, cachedInput: 80, output: 100 });
    assert.deepEqual(events, ["chunk", "exchange", "attempt-failed", "exchange", "term"]);

    assert.equal((await store.findTerm("Zhao Yun"))!.genders[0].gender, "m");
    assert.deepEqual(translator.usage, { input: 200, cachedInput: 80, output: 100 });
});

test("translator: a stable Latin share is accepted on the second attempt", async () => {
    const source = "Title\n\n" + "Some text here. ".repeat(100);
    const store = new MemoryGlossaryStore();
    // ~3.6% Latin: a handful of names the model rightly keeps in Latin
    const prose = Array.from({ length: 38 }, (_, i) => `Речення номер ${i} розповідає про героя.`).join(" ");
    const body = `${prose} Oregairu Munpia Harkanium Fecinom Totsuka Saika EER`;
    const model = new MockLanguageModelV3({
        doGenerate: async () => reply(`<title>Розділ</title>\n<translation>\n${body}\n</translation>\n<terms>[]</terms>`),
    });

    const res = await new Translator(parseConfig({}), setup(model), await Glossary.load(store)).translateChapter(4, source);
    assert.equal(res.status, "done");
    assert.equal(model.doGenerateCalls.length, 2);
});

test("translator: abort stops the request without a retry", async () => {
    const source = "Title\n\n" + "Some text here. ".repeat(100);
    const abort = new AbortController();
    const model = new MockLanguageModelV3({
        doGenerate: ({ abortSignal }) =>
            new Promise((_, reject) => abortSignal?.addEventListener("abort", () => reject(abortSignal.reason))),
    });

    const glossary = await Glossary.load(new MemoryGlossaryStore());
    const pending = new Translator(parseConfig({}), setup(model), glossary, { signal: abort.signal }).translateChapter(3, source);
    setTimeout(() => abort.abort(), 10);
    await assert.rejects(pending);
    assert.equal(model.doGenerateCalls.length, 1, "no retry after abort");
});

test("translator: chapter fails after maxAttempts", async () => {
    const source = "Title\n\n" + "Some text here. ".repeat(100);
    const model = new MockLanguageModelV3({ doGenerate: async () => reply("I cannot translate this.") });

    const glossary = await Glossary.load(new MemoryGlossaryStore());
    const res = await new Translator(parseConfig({ maxAttempts: 2 }), setup(model), glossary).translateChapter(2, source);
    assert.equal(res.status, "failed");
    if (res.status === "failed") {
        assert.match(res.reason, /missing <translation>/);
        assert.equal(res.rejected, undefined, "nothing came back to take");
    }
});

test("translator: a failed chapter keeps the last rejected attempt to take anyway", async () => {
    const source = "Title\n\n" + "Some text here. ".repeat(100);
    const model = new MockLanguageModelV3({ doGenerate: async () => reply("<title>Назва</title>\n<translation>\nЗанадто коротко.\n</translation>") });
    const glossary = await Glossary.load(new MemoryGlossaryStore());
    const res = await new Translator(parseConfig({ maxAttempts: 2 }), setup(model), glossary).translateChapter(2, source);
    assert.equal(res.status, "failed");
    if (res.status !== "failed") return;
    assert.deepEqual(res.rejected?.parts, ["Занадто коротко."]);
    assert.equal(res.rejected?.title, "Назва");
    assert.match(res.rejected!.problems[0], /too short/);
    assert.equal(res.rejected?.sources.length, 1);
});

test("translator: short sources are skipped without a request", async () => {
    const model = new MockLanguageModelV3({ doGenerate: async () => reply("") });
    const glossary = await Glossary.load(new MemoryGlossaryStore());
    const res = await new Translator(parseConfig({}), setup(model), glossary).translateChapter(1, "Title\n\nShort.");
    assert.equal(res.status, "skipped");
    assert.equal(model.doGenerateCalls.length, 0);
});

async function storeWithTowerAndZhao() {
    const store = new MemoryGlossaryStore();
    await store.insertTerm({ source: "Sky Tower", target: "Небесна Вежа", type: "place", firstChapter: null });
    await store.insertTerm({ source: "Zhao Yun", target: "Чжао Юнь", type: "person", firstChapter: null, gender: "m" });
    return store;
}

const proseWith = (tower: string) => `Чжао Юнь увійшов до ${tower} й довго роззирався навкруги, нічого не кажучи. `.repeat(18);
const towerSource = `Chapter 5\n\n${"Zhao Yun walked into the Sky Tower and looked around for a long while. ".repeat(20)}`;
const proposals =
    `[{"source":"Sky Tower","target":"Вежа Неба","type":"place","note":"literal"},` +
    `{"source":"Zhao Yun","target":"Чжао Юнь","type":"person","gender":"f"}]`;

test("translator: pending changes of a chunk are decided once, then the chunk is translated again", async () => {
    const store = await storeWithTowerAndZhao();
    const glossary = await Glossary.load(store);

    const responses = [
        reply(`<title>Розділ 5</title>\n<translation>\n${proseWith("Небесної Вежі")}\n</translation>\n<terms>${proposals}</terms>`),
        // the second pass proposes again: queued, not asked
        reply(`<title>Розділ 5</title>\n<translation>\n${proseWith("Вежі Неба")}\n</translation>\n<terms>[{"source":"Zhao Yun","target":"Чжао Юн","type":"person"}]</terms>`),
    ];
    const model = new MockLanguageModelV3({ doGenerate: async () => responses.shift()! });

    const asked: string[][] = [];
    const translator = new Translator(parseConfig({}), setup(model), glossary, {
        onPending: async (pending) => {
            asked.push(pending.map((o) => `${o.term.source}:${o.field}`));
            const change = (await store.listChanges("pending")).find((c) => c.field === "target")!;
            await store.updateTerm(change.termId, { target: change.newValue });
            await store.setChangeStatus(change.id, "applied");
            return "retranslate";
        },
    });
    const res = await translator.translateChapter(5, towerSource);

    assert.equal(res.status, "done");
    assert.deepEqual(asked, [["Sky Tower:target", "Zhao Yun:gender"]]);
    assert.equal(model.doGenerateCalls.length, 2);
    assert.match(JSON.stringify(model.doGenerateCalls[1].prompt), /Sky Tower → Вежа Неба/);
    if (res.status === "done") assert.match(res.content, /Вежі Неба/);
    assert.equal((await store.listChanges("pending")).length, 2, "gender left pending + the second-pass proposal");
});

test("translator: a pause stops the chapter, the proposals stay pending", async () => {
    const store = await storeWithTowerAndZhao();
    const model = new MockLanguageModelV3({
        doGenerate: async () => reply(`<title>Розділ 5</title>\n<translation>\n${proseWith("Небесної Вежі")}\n</translation>\n<terms>${proposals}</terms>`),
    });
    const translator = new Translator(parseConfig({}), setup(model), await Glossary.load(store), { onPending: async () => "pause" });
    const res = await translator.translateChapter(5, towerSource);

    assert.equal(res.status, "paused");
    assert.equal(model.doGenerateCalls.length, 1);
    assert.equal((await store.listChanges("pending")).length, 2);
});

test("translator: a draft from a pause is reused, only the chunks after it are translated", async () => {
    const store = await storeWithTowerAndZhao();
    const paragraph = "Zhao Yun walked into the Sky Tower and looked around for a long while. ".repeat(20);
    // three chunks of ~1400 characters
    const source = `Chapter 5\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const config = parseConfig({ chunkSize: 1500 });
    let calls = 0;
    const model = new MockLanguageModelV3({
        doGenerate: async () => {
            calls++;
            // the second chunk proposes changes the first time
            const terms = calls === 2 ? proposals : "[]";
            return reply(`<title>Розділ 5</title>\n<translation>\n${proseWith(`Небесної Вежі ${calls}`)}\n</translation>\n<terms>${terms}</terms>`);
        },
    });
    const paused = await new Translator(config, setup(model), await Glossary.load(store), { onPending: async () => "pause" }).translateChapter(5, source);
    assert.equal(paused.status, "paused");
    if (paused.status !== "paused") return;
    assert.equal(paused.draft.parts.length, 2, "the paused chunk is part of the draft");
    assert.equal(paused.draft.title, "Розділ 5");
    assert.deepEqual(paused.pending.map((p) => p.term.source).sort(), ["Sky Tower", "Zhao Yun"]);

    const events: string[] = [];
    const res = await new Translator(config, setup(model), await Glossary.load(store), {
        onPending: async () => "pause",
        onEvent: (e) => void events.push(e.type),
    }).translateChapter(5, source, paused.draft);
    assert.equal(res.status, "done");
    assert.equal(calls, 3, "only the third chunk is translated");
    assert.equal(events[0], "draft-reused");
    if (res.status === "done") {
        assert.match(res.content, /Вежі 1.*Вежі 2.*Вежі 3/s);
        assert.equal(res.title, "Розділ 5");
    }

    // a changed source makes the draft useless from that chunk on
    const changed = `Chapter 5\n\n${paragraph}\n\n${paragraph.replace("Sky", "Moon")}\n\n${paragraph}`;
    await new Translator(config, setup(model), await Glossary.load(store)).translateChapter(5, changed, paused.draft);
    assert.equal(calls, 5);
});

test("translator: every request reports its own usage", async () => {
    const source = "Title\n\n" + "Some text here. ".repeat(100);
    const model = new MockLanguageModelV3({ doGenerate: async () => reply("no translation block") });
    const seen: { attempt: number; input: number; failed: boolean }[] = [];
    const glossary = await Glossary.load(new MemoryGlossaryStore());
    await new Translator(parseConfig({ maxAttempts: 2 }), setup(model), glossary, {
        onEvent: (e) => {
            if (e.type === "exchange") seen.push({ attempt: e.attempt, input: e.usage.input, failed: e.failed });
        },
    }).translateChapter(1, source);
    assert.deepEqual(seen, [
        { attempt: 1, input: 100, failed: false },
        { attempt: 2, input: 100, failed: false },
    ]);
});
