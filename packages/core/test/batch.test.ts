import assert from "node:assert/strict";
import { test } from "node:test";
import { genderTimeline, parseExtraction, resolveCandidates, variantsOf, type Candidate } from "../src/batch/candidates";
import { batchUserPrompt } from "../src/batch/prompts";
import type { Term } from "../src/glossary/store";

const cand = (chapter: number, target: string, extra: Partial<Candidate> = {}): Candidate => ({
    chapter,
    source: "Zhao Yun",
    target,
    type: "person",
    gender: null,
    note: "",
    evidence: "",
    ...extra,
});

test("extraction: JSON array with noise around it, unknown types, gender only for persons", () => {
    const raw = 'Here you go:\n```json\n[{"source":"Zhao Yun","target":"Чжао Юнь","type":"person","gender":"m"},{"source":"Saintess","target":"Свята","type":"rank","gender":"f"},{"source":"x","target":"","type":"place"},{"source":"Qi","target":"Ці","type":"energy"}]\n```';
    const { terms, problems } = parseExtraction(raw);
    assert.deepEqual(problems, []);
    assert.deepEqual(
        terms.map((t) => [t.source, t.type, t.gender]),
        [
            ["Zhao Yun", "person", "m"],
            ["Saintess", "rank", undefined],
            ["Qi", "other", undefined],
        ]
    );
    assert.deepEqual(parseExtraction("no terms here").problems, ["no JSON array in the reply"]);
    assert.deepEqual(parseExtraction("[]").terms, []);
});

test("candidates: variants ignore case, timeline merges repeats", () => {
    const cs = [cand(1, "Чжао Юнь", { gender: "m" }), cand(2, "чжао юнь", { gender: "unknown" }), cand(3, "Чжао Юнь", { gender: "m" }), cand(40, "Чжао Юн", { gender: "f" })];
    assert.deepEqual(
        variantsOf(cs).map((v) => [v.target, v.count]),
        [
            ["Чжао Юнь", 3],
            ["Чжао Юн", 1],
        ]
    );
    assert.deepEqual(genderTimeline(cs), [
        { fromChapter: 1, gender: "m" },
        { fromChapter: 40, gender: "f" },
    ]);
});

test("candidates: agreement is added, disagreement is a conflict", () => {
    const added = resolveCandidates([cand(3, "Чжао Юнь", { gender: "m", note: "hero" }), cand(5, "Чжао Юнь")]);
    assert.equal(added.kind, "add");
    if (added.kind === "add") {
        assert.equal(added.entry.firstChapter, 3);
        assert.equal(added.entry.note, "hero");
        assert.deepEqual(added.entry.genders, [{ fromChapter: 3, gender: "m" }]);
    }
    const conflict = resolveCandidates([cand(1, "Чжао Юнь"), cand(2, "Чжао Юн")]);
    assert.equal(conflict.kind, "conflict");
    assert.equal(resolveCandidates([cand(1, "Чжао Юнь", { gender: "m" }), cand(9, "Чжао Юнь", { gender: "f" })]).kind, "conflict");
});

test("candidates: a title held by a woman is not a gender conflict", () => {
    const title = (chapter: number, gender: Candidate["gender"]): Candidate => ({ ...cand(chapter, "Святий"), source: "Saint", type: "rank", gender });
    const r = resolveCandidates([title(1, "m"), title(2, "f"), { ...title(3, null), type: "person" }]);
    assert.equal(r.kind, "add");
    if (r.kind === "add") {
        assert.equal(r.entry.type, "rank");
        assert.deepEqual(r.entry.genders, []);
    }
});

test("candidates: against the glossary", () => {
    const term: Term = { id: 1, source: "Zhao Yun", target: "Чжао Юнь", type: "person", note: "", locked: false, firstChapter: 1, genders: [{ fromChapter: 1, gender: "unknown" }] };
    assert.deepEqual(resolveCandidates([cand(4, "чжао юнь", { gender: "f" })], term), { kind: "agrees", gender: "f" });
    assert.equal(resolveCandidates([cand(4, "Чжао Юн")], term).kind, "conflict");
    const known: Term = { ...term, genders: [{ fromChapter: 1, gender: "m" }] };
    assert.equal(resolveCandidates([cand(4, "Чжао Юнь", { gender: "m" })], known).kind, "agrees");
    assert.equal(resolveCandidates([cand(4, "Чжао Юнь", { gender: "f" })], known).kind, "conflict");
});

test("batch prompt: source context instead of the previous translation", () => {
    const p = batchUserPrompt({ text: "Body", terms: [], chapter: 1, chunk: 1, totalChunks: 2, sourceContext: "end of part one" });
    assert.match(p, /<previous_source>\n…end of part one/);
    assert.match(p, /continuation chunk/);
});

test("prompts: Ukrainian rules only when translating into Ukrainian", async () => {
    const { extractSystemPrompt, batchSystemPrompt } = await import("../src/batch/prompts");
    const { systemPrompt } = await import("../src/pipeline/prompt");
    const { parseConfig } = await import("../src/config");
    const uk = parseConfig({ targetLanguage: "Ukrainian" });
    for (const p of [systemPrompt(uk), batchSystemPrompt(uk)]) {
        assert.match(p, /## Ukrainian\n- Format direct speech/);
        assert.match(p, /translated by meaning, not transliterated/);
    }
    // the glossary has no dialogue, only names
    assert.doesNotMatch(extractSystemPrompt(uk), /direct speech/);
    assert.match(extractSystemPrompt(uk), /transliterate only names that have no meaning in English/);
    assert.doesNotMatch(batchSystemPrompt(parseConfig({ targetLanguage: "Polish" })), /## Ukrainian/);
});

test("text: a cut through an emoji leaves no lone surrogate", async () => {
    const { wellFormed } = await import("../src/pipeline/text");
    const emoji = "a😀b";
    const cut = emoji.slice(0, 2); // "a" + the high half of the emoji
    assert.equal(wellFormed(cut), "a�");
    assert.equal(wellFormed(emoji.slice(2)), "�b");
    assert.equal(wellFormed(emoji), emoji);
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(wellFormed(cut))));
    const { batchParams } = await import("../src/batch/anthropic");
    const p = batchParams({ model: "m", system: cut, prompt: `context ${cut}`, maxTokens: 10 });
    assert.equal(p.messages[0].content, "context a�");
});
