import type { Config } from "../config.js";

export interface Validation {
    ok: boolean;
    problems: string[];
    ratio: number;
    latinPercent: number;
}

const LEAK_PATTERNS: [RegExp, string][] = [
    [/<\/?(?:title|translation|terms|source|glossary|previous_translation)>/i, "prompt tags left in the text"],
    [/```/, "code fence in the text"],
    [/^\s*[{[]\s*"/, "text looks like JSON"],
    [/\[(?:person|place|organization|technique|item|rank|creature|other)(?:,|\])/, "glossary annotation copied into the text"],
    [/"(?:source|target)"\s*:/, "terms JSON inside the text"],
];

/**
 * Longest run of a word n-gram (1–8 words) repeated back to back, e.g. "the the the …".
 * `span` is the run length in characters: laughter like "ха ха ха" stays short,
 * a model stuck in a loop produces hundreds of characters.
 */
export function longestRepeat(text: string): { gram: string; count: number; span: number } {
    const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    let best = { gram: "", count: 1, span: 0 };
    for (let n = 1; n <= 8; n++) {
        let i = 0;
        while (i + 2 * n <= words.length) {
            let count = 1;
            while (sameGram(words, i, i + count * n, n)) count++;
            if (count > 1) {
                const gram = words.slice(i, i + n).join(" ");
                const span = (gram.length + 1) * count;
                if (span > best.span) best = { gram, count, span };
                i += count * n;
            } else {
                i++;
            }
        }
    }
    return best;
}

function sameGram(words: string[], a: number, b: number, n: number): boolean {
    if (b + n > words.length) return false;
    for (let k = 0; k < n; k++) if (words[a + k] !== words[b + k]) return false;
    return true;
}

/** Below this many Latin letters a chunk is never flagged: a few names or a short note are fine. */
const MIN_LATIN_LETTERS = 40;

export function latinPercent(text: string): number {
    const latin = text.match(/[a-zA-Z]/g)?.length ?? 0;
    const letters = text.match(/\p{L}/gu)?.length ?? 0;
    return letters ? (latin / letters) * 100 : 0;
}

export function validateTranslation(source: string, translation: string, config: Config, parseProblems: string[] = []): Validation {
    const v = config.validation;
    const problems = [...parseProblems];
    const ratio = source.length ? translation.length / source.length : 0;
    const latin = latinPercent(translation);

    if (!translation.trim()) problems.push("empty translation");
    else if (ratio < v.minRatio) {
        problems.push(`translation is too short (${(ratio * 100).toFixed(0)}% of source length, expected ≥ ${v.minRatio * 100}%): translate the whole text, do not skip or summarize`);
    } else if (ratio > v.maxRatio) {
        problems.push(`translation is too long (${(ratio * 100).toFixed(0)}% of source length, expected ≤ ${v.maxRatio * 100}%): do not add commentary or repeat text`);
    }
    const latinLetters = translation.match(/[a-zA-Z]/g)?.length ?? 0;
    if (latin > v.maxLatinPercent && latinLetters >= MIN_LATIN_LETTERS) {
        problems.push(`too much untranslated ${config.sourceLanguage} text (${latin.toFixed(1)}% Latin letters)`);
    }
    const repeat = longestRepeat(translation);
    if (repeat.count >= 3 && repeat.span >= v.maxRepeatSpan) {
        problems.push(`the text degenerates into a loop ("${repeat.gram.slice(0, 40)}" repeated ${repeat.count} times)`);
    }
    for (const [re, msg] of LEAK_PATTERNS) {
        if (re.test(translation)) problems.push(msg);
    }
    return { ok: problems.length === 0, problems, ratio, latinPercent: latin };
}
