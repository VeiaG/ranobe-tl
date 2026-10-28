import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { parseConfig } from "../src/config.js";
import { Glossary } from "../src/glossary/glossary.js";
import { MemoryGlossaryStore } from "../src/glossary/store.js";
import { Translator, type TranslatorEvent } from "../src/pipeline/translator.js";

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
    if (res.status === "failed") assert.match(res.reason, /missing <translation>/);
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
