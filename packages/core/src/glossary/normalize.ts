/** Key used for uniqueness: case, quotes, dashes and spacing don't matter. */
export function normalizeTerm(term: string): string {
    return term
        .normalize("NFKC")
        .replace(/[’‘`´]/g, "'")
        .replace(/[‐‑‒–—]/g, "-")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}

/** Looser key for "probably the same term": also ignores hyphens and a plural/possessive tail. */
export function looseKey(term: string): string {
    return normalizeTerm(term)
        .replace(/-/g, " ")
        .split(" ")
        .map((w) => w.replace(/'s$/, "").replace(/(?<=\w{3})s$/, ""))
        .join(" ");
}

export function levenshtein(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(
                prev[j] + 1,
                cur[j - 1] + 1,
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
        }
        prev = cur;
    }
    return prev[b.length];
}
