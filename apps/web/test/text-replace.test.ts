import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMatchCase, buildRegex, makeSnippet, replaceAll } from "../src/lib/text-replace";

const plain = { useRegex: false, preserveCase: false };

test("plain text is literal, in the find and in the replacement", () => {
    const out = replaceAll("a.b a+b $&", buildRegex("a.b", false, false), "$&", plain);
    assert.equal(out.text, "$& a+b $&");
    assert.equal(out.count, 1);
});

test("keeping the case follows each match", () => {
    const out = replaceAll("Глава 1. глава. ГЛАВА", buildRegex("глава", false, false), "розділ", { useRegex: false, preserveCase: true });
    assert.equal(out.text, "Розділ 1. розділ. РОЗДІЛ");
    assert.equal(out.count, 3);
    assert.equal(applyMatchCase("сЛоВо", "заміна"), "заміна");
    assert.equal(applyMatchCase("Г", "розділ"), "Розділ");
});

test("match case finds only the exact spelling", () => {
    assert.equal(replaceAll("Глава глава", buildRegex("Глава", false, true), "Розділ", plain).text, "Розділ глава");
});

test("regular expressions expand groups", () => {
    const opts = { useRegex: true, preserveCase: false };
    assert.equal(replaceAll("Глава 12: Начало", buildRegex("^Глава (\\d+)", true, false), "Розділ $1", opts).text, "Розділ 12: Начало");
    assert.equal(replaceAll("x-1", buildRegex("(?<n>\\d)", true, false), "[$<n>]", opts).text, "x-[1]");
    assert.equal(replaceAll("ab", buildRegex("(a)", true, false), "$12", opts).text, "a2b");
});

test("the outcome points at the first match for the preview", () => {
    const out = replaceAll("one two two", buildRegex("two", false, false), "2", plain);
    assert.deepEqual([out.firstIndex, out.firstMatchLength, out.firstReplacementLength], [4, 3, 1]);
    assert.equal(makeSnippet("x".repeat(100) + "two" + "y".repeat(100), 100, 3, 5), "…xxxxxtwoyyyyy…");
});
