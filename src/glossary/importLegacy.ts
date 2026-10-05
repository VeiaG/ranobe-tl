import { normalizeTerm } from "./normalize.js";
import type { Gender, GlossaryStore, TermType } from "./store.js";

export interface LegacyEntry {
    source: string;
    target: string;
    type: TermType;
    gender?: Gender;
    note: string;
}

const GENDER_WORDS: [RegExp, Gender][] = [
    [/^(чоловік|чол\.?|хлопець|male|m)$/i, "m"],
    [/^(жінка|жін\.?|дівчина|female|f)$/i, "f"],
];

const TYPE_WORDS: [RegExp, TermType][] = [
    [/геогр|місто|місце|гора|острів|країна|регіон/i, "place"],
    [/техні|навич|прийом|стиль/i, "technique"],
    [/клан|секта|організац|школа|орден|сім'я|родина/i, "organization"],
    [/артефакт|скарб|предмет|зброя|пігулка/i, "item"],
    [/ранг|рівень|царство культивації|стадія/i, "rank"],
    [/звір|істота|раса/i, "creature"],
];

/** Parses a value of the old flat memory file: "Лінь Мін (чоловік)" → target + gender, other "(…)" → note. */
export function parseLegacyValue(source: string, value: string): LegacyEntry {
    const notes: string[] = [];
    let gender: Gender | undefined;
    let type: TermType = "other";

    for (const m of value.matchAll(/\(([^)]*)\)/g)) {
        for (const part of m[1].split(/[,/;]/).map((s) => s.trim()).filter(Boolean)) {
            const g = GENDER_WORDS.find(([re]) => re.test(part));
            if (g) {
                gender = g[1];
                continue;
            }
            const t = TYPE_WORDS.find(([re]) => re.test(part));
            if (t && type === "other") type = t[1];
            notes.push(part);
        }
    }
    if (gender) type = "person";

    const target = value.replace(/\s*\([^)]*\)/g, "").trim();
    return { source: source.trim(), target, type, gender, note: notes.join(", ") };
}

export function importLegacy(
    store: GlossaryStore,
    memory: Record<string, string>
): { imported: number; duplicates: { kept: string; skipped: string }[]; existing: number } {
    const duplicates: { kept: string; skipped: string }[] = [];
    const seen = new Map<string, string>();
    let imported = 0;
    let existing = 0;

    store.transaction(() => {
        for (const [source, value] of Object.entries(memory)) {
            const key = normalizeTerm(source);
            if (seen.has(key)) {
                duplicates.push({ kept: seen.get(key)!, skipped: source });
                continue;
            }
            seen.set(key, source);
            if (store.findTerm(source)) {
                existing++;
                continue;
            }
            const e = parseLegacyValue(source, value);
            if (!e.target) continue;
            store.insertTerm({ ...e, firstChapter: null, gender: e.type === "person" ? e.gender : undefined });
            imported++;
        }
    });
    return { imported, duplicates, existing };
}
