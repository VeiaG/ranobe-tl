import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { loadConfig, type Config } from "../src/config.js";
import { Glossary } from "../src/glossary/glossary.js";
import { GlossaryStore } from "../src/glossary/store.js";
import { Translator } from "../src/pipeline/translator.js";
import { createModel, resolveModelId } from "../src/providers.js";

const base = { baseURL: undefined } as Partial<Config>;

test("providers: default models, keys and options", () => {
    process.env.OPENAI_API_KEY = "x";
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "x";

    assert.equal(resolveModelId({ provider: "openai", model: undefined }), "gpt-6-luna");
    assert.equal(resolveModelId({ provider: "anthropic", model: undefined }), "claude-opus-5-5");
    assert.throws(() => resolveModelId({ provider: "google", model: undefined }), /must be set/);

    const anthropic = createModel({ ...base, provider: "anthropic", effort: "low" } as Config);
    assert.deepEqual(anthropic.providerOptions, { anthropic: { effort: "low" } });
    assert.deepEqual(anthropic.systemProviderOptions, { anthropic: { cacheControl: { type: "ephemeral" } } });

    const openai = createModel({ ...base, provider: "openai", effort: "high" } as Config);
    assert.deepEqual(openai.providerOptions, { openai: { reasoningEffort: "high" } });

    const google = createModel({ ...base, provider: "google", model: "gemini-x" } as Config);
    assert.deepEqual(google.providerOptions, { google: { threshold: "BLOCK_NONE" } });

    delete process.env.ANTHROPIC_API_KEY;
    assert.throws(() => createModel({ ...base, provider: "anthropic" } as Config), /ANTHROPIC_API_KEY/);
});

test("translator: system message carries cache options, request carries provider options", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ranobe-tl-"));
    mkdirSync(path.join(root, "chapters"));
    writeFileSync(path.join(root, "chapters", "00001.txt"), "Title\n\n" + "Some text here. ".repeat(100));
    writeFileSync(path.join(root, "novel.json"), JSON.stringify({ range: { start: 1, end: 1 }, maxAttempts: 1 }));
    const config = await loadConfig(root);
    const store = new GlossaryStore(":memory:");
    const model = new MockLanguageModelV3({
        doGenerate: async () => ({
            content: [{ type: "text", text: "nothing useful" }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
        }),
    });
    const setup = {
        model,
        providerOptions: { anthropic: { effort: "low" } },
        systemProviderOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    };
    await new Translator(config, setup, new Glossary(store), store).translateChapter(1);

    const call = model.doGenerateCalls[0];
    assert.equal(call.prompt[0].role, "system");
    assert.deepEqual(call.prompt[0].providerOptions, setup.systemProviderOptions);
    assert.deepEqual(call.providerOptions, setup.providerOptions);
    assert.equal(call.maxOutputTokens, 32000);
});
