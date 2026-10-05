import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { loadConfig } from "../src/config.js";
import { Glossary } from "../src/glossary/glossary.js";
import { GlossaryStore } from "../src/glossary/store.js";
import { Translator } from "../src/pipeline/translator.js";

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

test("translator: retries with feedback, applies terms, writes output", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ranobe-tl-"));
    mkdirSync(path.join(root, "chapters"));
    const body = "Zhao Yun walked into the Sky Tower and looked around for a long while. ".repeat(20);
    writeFileSync(path.join(root, "chapters", "00001.txt"), `Chapter 1 - Arrival\n\nChapter 1 - Arrival\n\n${body}`);
    writeFileSync(path.join(root, "novel.json"), JSON.stringify({ range: { start: 1, end: 1 } }));

    const config = await loadConfig(root);
    const store = new GlossaryStore(":memory:");
    store.insertTerm({ source: "Sky Tower", target: "Небесна Вежа", type: "place", firstChapter: null });
    const glossary = new Glossary(store);

    const good = "Чжао Юнь увійшов до Небесної Вежі й довго роззирався навкруги, нічого не кажучи. ".repeat(18);
    const responses = [
        reply("<title>Розділ 1</title>\n<translation>\nЗанадто коротко.\n</translation>\n<terms>[]</terms>"),
        reply(
            `<title>Розділ 1 - Прибуття</title>\n<translation>\n${good}\n</translation>\n<terms>\n` +
                `[{"source":"Zhao Yun","target":"Чжао Юнь","type":"person","gender":"m"}]\n</terms>`
        ),
    ];
    const model = new MockLanguageModelV3({ doGenerate: async () => responses.shift()! });

    const translator = new Translator(config, model, glossary, store);
    const res = await translator.translateChapter(1);

    assert.equal(res.status, "done");
    assert.equal(model.doGenerateCalls.length, 2);

    const firstPrompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    assert.match(firstPrompt, /Sky Tower → Небесна Вежа \[place\]/);
    assert.equal((firstPrompt.match(/Chapter 1 - Arrival/g) ?? []).length, 1, "duplicated title removed");
    assert.match(JSON.stringify(model.doGenerateCalls[1].prompt), /previous attempt was rejected: translation is too short/);

    const out = JSON.parse(readFileSync(path.join(root, "translation", "00001.json"), "utf-8"));
    assert.equal(out.title, "Розділ 1 - Прибуття");
    assert.equal(out.content, good.trim());

    assert.equal(store.findTerm("Zhao Yun")!.genders[0].gender, "m");
    assert.equal(store.listChapters()[0].status, "done");
    assert.deepEqual(translator.usage, { input: 200, cachedInput: 80, output: 100 });

    assert.equal((await translator.translateChapter(1)).status, "exists");
});

test("translator: chapter fails after maxAttempts and is recorded", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ranobe-tl-"));
    mkdirSync(path.join(root, "chapters"));
    writeFileSync(path.join(root, "chapters", "00002.txt"), "Title\n\n" + "Some text here. ".repeat(100));
    writeFileSync(path.join(root, "novel.json"), JSON.stringify({ range: { start: 2, end: 2 }, maxAttempts: 2 }));
    const config = await loadConfig(root);
    const store = new GlossaryStore(":memory:");
    const model = new MockLanguageModelV3({ doGenerate: async () => reply("I cannot translate this.") });

    const res = await new Translator(config, model, new Glossary(store), store).translateChapter(2);
    assert.equal(res.status, "failed");
    assert.match(store.listChapters("failed")[0].error, /missing <translation>/);
});
