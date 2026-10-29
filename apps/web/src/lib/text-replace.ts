// Find and replace over chapter text (ported from wuji.world's editor page).

/** Patterns longer than this are refused: a sync replace over a whole novel should not hang on backtracking. */
export const MAX_PATTERN_LENGTH = 500;

export const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildRegex(find: string, useRegex: boolean, caseSensitive: boolean): RegExp {
    return new RegExp(useRegex ? find : escapeRegExp(find), caseSensitive ? "g" : "gi");
}

interface MatchInfo {
    match: string;
    captures: (string | undefined)[];
    offset: number;
    source: string;
    groups: Record<string, string | undefined> | undefined;
}

// String.replace calls the callback with (match, p1…pN, offset, source[, groups]); groups only with named groups.
function parseReplaceArgs(args: unknown[]): MatchInfo {
    const last = args[args.length - 1];
    const hasGroups = typeof last === "object" && last !== null;
    const tail = hasGroups ? 3 : 2;
    return {
        match: args[0] as string,
        captures: args.slice(1, args.length - tail) as (string | undefined)[],
        offset: args[args.length - tail] as number,
        source: args[args.length - tail + 1] as string,
        groups: hasGroups ? (last as Record<string, string | undefined>) : undefined,
    };
}

// The engine expands $&, $1, $<name> only for a string replacement; the callback form needs it done by hand.
function expandTemplate(template: string, info: MatchInfo): string {
    return template.replace(/\$(\$|&|`|'|<([^>]*)>|\d{1,2})/g, (token: string, key: string, groupName?: string) => {
        if (key === "$") return "$";
        if (key === "&") return info.match;
        if (key === "`") return info.source.slice(0, info.offset);
        if (key === "'") return info.source.slice(info.offset + info.match.length);
        // without named groups in the pattern $<…> is plain text
        if (groupName !== undefined) return info.groups ? (info.groups[groupName] ?? "") : token;
        const index = Number(key);
        if (index >= 1 && index <= info.captures.length) return info.captures[index - 1] ?? "";
        // $12 with fewer groups is group 1 followed by "2"
        if (key.length === 2) {
            const single = Number(key[0]);
            if (single >= 1 && single <= info.captures.length) return (info.captures[single - 1] ?? "") + key[1];
        }
        return token;
    });
}

const LETTER = /\p{L}/u;

/** The replacement in the case of the matched text: word → заміна, WORD → ЗАМІНА, Word → Заміна; mixed case keeps it as is. */
export function applyMatchCase(matched: string, replacement: string): string {
    if (matched.toLowerCase() === matched.toUpperCase() || !LETTER.test(matched)) return replacement;
    const letters = matched.match(/\p{L}/gu) ?? [];
    // a single capital letter starts a word, it is not caps
    if (letters.length > 1 && matched === matched.toUpperCase()) return replacement.toUpperCase();
    if (matched === matched.toLowerCase()) return replacement.toLowerCase();
    const first = letters[0];
    if (first && first === first.toUpperCase()) return replacement.replace(LETTER, (l) => l.toUpperCase());
    return replacement;
}

export interface ReplaceOutcome {
    text: string;
    count: number;
    /** Where the first match starts in the source, -1 without matches. */
    firstIndex: number;
    firstMatchLength: number;
    /** Differs from the template's length when the case is adjusted. */
    firstReplacementLength: number;
}

/**
 * Replaces every match. In plain mode the replacement goes in literally ($& is not special);
 * with a regular expression $1, $<name> and friends are expanded.
 */
export function replaceAll(source: string, regex: RegExp, template: string, options: { useRegex: boolean; preserveCase: boolean }): ReplaceOutcome {
    let count = 0;
    let firstIndex = -1;
    let firstMatchLength = 0;
    let firstReplacementLength = 0;
    regex.lastIndex = 0;
    const text = source.replace(regex, (...args: unknown[]) => {
        const info = parseReplaceArgs(args);
        const expanded = options.useRegex ? expandTemplate(template, info) : template;
        const result = options.preserveCase ? applyMatchCase(info.match, expanded) : expanded;
        if (count === 0) {
            firstIndex = info.offset;
            firstMatchLength = info.match.length;
            firstReplacementLength = result.length;
        }
        count++;
        return result;
    });
    return { text, count, firstIndex, firstMatchLength, firstReplacementLength };
}

/** The text around a match, for the preview. */
export function makeSnippet(text: string, index: number, length: number, context = 60): string {
    if (index < 0) return text.slice(0, context * 2);
    const start = Math.max(0, index - context);
    const end = Math.min(text.length, index + length + context);
    return (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
}
