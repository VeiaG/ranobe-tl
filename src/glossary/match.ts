import { normalizeTerm } from "./normalize.js";

const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

interface Entry<T> {
    words: string[];
    /** Single capitalized words ("White", "Clear") only match capitalized occurrences. */
    caseSensitive: boolean;
    value: T;
}

function tokenize(text: string): { word: string; raw: string }[] {
    return Array.from(text.matchAll(WORD_RE), (m) => ({
        raw: m[0],
        word: normalizeTerm(m[0]),
    }));
}

function stripTail(word: string): string[] {
    const out = [word];
    if (word.endsWith("'s")) out.push(word.slice(0, -2));
    else if (word.endsWith("es")) out.push(word.slice(0, -2), word.slice(0, -1));
    else if (word.endsWith("s")) out.push(word.slice(0, -1));
    return out;
}

/**
 * Finds which known terms occur in a text. Multi-word terms are matched
 * token by token, the longest match wins ("Mu Yuhuang" hides "Mu"), and the
 * last word may carry a possessive or plural tail.
 */
export class TermMatcher<T> {
    private byFirstWord = new Map<string, Entry<T>[]>();

    add(source: string, value: T): void {
        const tokens = tokenize(source);
        if (!tokens.length) return;
        const entry: Entry<T> = {
            words: tokens.map((t) => t.word),
            caseSensitive: tokens.length === 1 && /^\p{Lu}/u.test(tokens[0].raw),
            value,
        };
        const list = this.byFirstWord.get(entry.words[0]) ?? [];
        list.push(entry);
        list.sort((a, b) => b.words.length - a.words.length);
        this.byFirstWord.set(entry.words[0], list);
    }

    find(text: string): T[] {
        const tokens = tokenize(text);
        const found = new Set<T>();
        let i = 0;
        while (i < tokens.length) {
            const matched = this.matchAt(tokens, i);
            if (matched) {
                found.add(matched.value);
                i += matched.words.length;
            } else {
                i++;
            }
        }
        return [...found];
    }

    private matchAt(tokens: { word: string; raw: string }[], i: number): Entry<T> | undefined {
        const candidates = new Set(
            tokens[i] ? stripTail(tokens[i].word).flatMap((w) => this.byFirstWord.get(w) ?? []) : []
        );
        const sorted = [...candidates].sort((a, b) => b.words.length - a.words.length);
        for (const entry of sorted) {
            const n = entry.words.length;
            if (i + n > tokens.length) continue;
            let ok = true;
            for (let k = 0; k < n && ok; k++) {
                const tok = tokens[i + k];
                ok = k === n - 1 ? stripTail(tok.word).includes(entry.words[k]) : tok.word === entry.words[k];
            }
            if (ok && entry.caseSensitive && !/^\p{Lu}/u.test(tokens[i].raw)) ok = false;
            if (ok) return entry;
        }
        return undefined;
    }
}
