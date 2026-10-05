import assert from "node:assert/strict";
import { test } from "node:test";
import { Glossary, evidenceFound } from "../src/glossary/glossary.js";
import { importLegacy, parseLegacyValue } from "../src/glossary/importLegacy.js";
import { TermMatcher } from "../src/glossary/match.js";
import { GlossaryStore, genderAt } from "../src/glossary/store.js";
import { chunkText, dedupeTitle } from "../src/pipeline/preprocess.js";
import { parseOutput } from "../src/pipeline/parse.js";
import { validateTranslation } from "../src/pipeline/validate.js";
import type { Config } from "../src/config.js";

const config = {
    sourceLanguage: "English",
    validation: { minSourceChars: 10, minRatio: 0.8, maxRatio: 1.15, maxLatinPercent: 3 },
} as Config;

test("matcher: longest match, possessive, capitalized single words", () => {
    const m = new TermMatcher<string>();
    for (const t of ["Mu", "Mu Yuhuang", "White", "spirit vein", "Battle Spirit"]) m.add(t, t);
    const found = m.find("Mu Yuhuang's sword was white. The spirit veins glowed; his battle spirit rose.");
    assert.deepEqual(found.sort(), ["Battle Spirit", "Mu Yuhuang", "spirit vein"]);
    assert.deepEqual(m.find("Old White and Mu came."), ["White", "Mu"]);
});

test("legacy import: gender and notes leave the target", () => {
    assert.deepEqual(parseLegacyValue("Lin Ming", "Лінь Мін (чоловік)"), {
        source: "Lin Ming", target: "Лінь Мін", type: "person", gender: "m", note: "",
    });
    const place = parseLegacyValue("South Sea", "Південне море (географічна назва)");
    assert.equal(place.target, "Південне море");
    assert.equal(place.type, "place");
    assert.equal(place.note, "географічна назва");

    const store = new GlossaryStore(":memory:");
    const res = importLegacy(store, { "Battle Spirit": "Бойовий дух", "battle spirit": "бойовий дух", "Qin": "Цінь (жінка)" });
    assert.equal(res.imported, 2);
    assert.equal(res.duplicates.length, 1);
    assert.equal(store.findTerm("qin")!.genders[0].gender, "f");
});

test("glossary rules: new, variant, target change, gender changes", () => {
    const store = new GlossaryStore(":memory:");
    const g = new Glossary(store);
    const src = "Zhao Yun drew the blade. She smiled coldly at the Sky Tower.";

    assert.equal(g.propose({ source: "Zhao Yun", target: "Чжао Юнь", type: "person", gender: "m" }, 10, src)[0].kind, "added");
    assert.equal(g.propose({ source: "Sky Tower", target: "Небесна Вежа", type: "place" }, 10, src)[0].kind, "added");
    // plural / hyphen variant is not added as a new term
    assert.equal(g.propose({ source: "Sky-Towers", target: "Небесні Вежі", type: "place" }, 11, src)[0].kind, "similar");

    // translation change → pending, applied only on accept
    const t = g.propose({ source: "Sky Tower", target: "Вежа Неба", type: "place" }, 12, src);
    assert.equal(t[0].kind, "pending");
    assert.equal(store.findTerm("Sky Tower")!.target, "Небесна Вежа");

    // m → f without evidence → pending; with a real quote → applied from that chapter
    assert.equal(g.propose({ source: "Zhao Yun", target: "Чжао Юнь", type: "person", gender: "f" }, 20, src)[0].kind, "pending");
    const changed = g.propose({ source: "Zhao Yun", target: "Чжао Юнь", type: "person", gender: "f", evidence: "She smiled coldly" }, 20, src);
    assert.equal(changed[0].kind, "gender-changed");
    const zhao = store.findTerm("Zhao Yun")!;
    assert.equal(genderAt(zhao, 15), "m");
    assert.equal(genderAt(zhao, 25), "f");

    // unknown → known is resolved retroactively
    g.propose({ source: "Elder Bai", target: "Старійшина Бай", type: "person" }, 5, src);
    assert.equal(g.propose({ source: "Elder Bai", target: "Старійшина Бай", type: "person", gender: "f" }, 30, src)[0].kind, "gender-resolved");
    assert.equal(genderAt(store.findTerm("Elder Bai")!, 5), "f");

    // locked terms are never changed
    store.updateTerm(store.findTerm("Sky Tower")!.id, { locked: true });
    assert.equal(g.propose({ source: "Sky Tower", target: "Інша", type: "place" }, 40, src)[0].kind, "rejected");
});

test("evidence must be a real quote", () => {
    assert.ok(evidenceFound("she  smiled   COLDLY", "Then she smiled coldly."));
    assert.ok(!evidenceFound("she laughed", "Then she smiled coldly."));
    assert.ok(!evidenceFound("she", "she"));
});

test("parse: blocks, truncation, junk terms", () => {
    const ok = parseOutput('<title>Розділ 1</title>\n<translation>\nТекст.\n</translation>\n<terms>\n[{"source":"A","target":"Б","type":"weird"}, {"bad":1}]\n</terms>');
    assert.equal(ok.title, "Розділ 1");
    assert.equal(ok.translation, "Текст.");
    assert.deepEqual(ok.terms.map((t) => [t.source, t.type]), [["A", "other"]]);
    assert.deepEqual(ok.problems, []);

    const cut = parseOutput("<translation>\nПочаток тексту");
    assert.match(cut.problems.join(), /not closed/);
});

test("validate: ratio, latin, leaks", () => {
    const source = "a".repeat(1000);
    assert.ok(validateTranslation(source, "б".repeat(930), config).ok);
    assert.match(validateTranslation(source, "б".repeat(500), config).problems.join(), /too short/);
    assert.match(validateTranslation(source, "б".repeat(900) + "x".repeat(60), config).problems.join(), /Latin/);
    assert.match(validateTranslation(source, "б".repeat(900) + " [person, m]", config).problems.join(), /annotation/);
});

test("preprocess: duplicated title and chunking", () => {
    assert.equal(dedupeTitle("Chapter 5 – Wind\n\nChapter 5 - Wind\n\nText"), "Chapter 5 – Wind\n\n\nText");
    const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i} `.repeat(20)).join("\n\n");
    const chunks = chunkText(text, 2000);
    assert.ok(chunks.every((c) => c.length <= 2000));
    assert.equal(chunks.join("\n\n").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});
