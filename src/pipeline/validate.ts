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
    if (latin > v.maxLatinPercent) {
        problems.push(`too much untranslated ${config.sourceLanguage} text (${latin.toFixed(1)}% Latin letters)`);
    }
    for (const [re, msg] of LEAK_PATTERNS) {
        if (re.test(translation)) problems.push(msg);
    }
    return { ok: problems.length === 0, problems, ratio, latinPercent: latin };
}
