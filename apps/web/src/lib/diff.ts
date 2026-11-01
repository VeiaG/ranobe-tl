// Small text diff for reviewing edits: paragraphs (lines) first, then words inside a changed pair.

export type Segment = { kind: "same" | "del" | "add"; text: string };

/** Longest common subsequence alignment of two token lists. */
function align<T>(a: T[], b: T[]): ["same" | "del" | "add", number][] {
    const n = a.length;
    const m = b.length;
    // trim the common head and tail: edits usually touch little of a long text
    let start = 0;
    while (start < n && start < m && a[start] === b[start]) start++;
    let endA = n;
    let endB = m;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const ops: ["same" | "del" | "add", number][] = [];
    for (let i = 0; i < start; i++) ops.push(["same", i]);
    const rows = endA - start;
    const cols = endB - start;
    if (rows * cols > 4_000_000) {
        // too big to align: all of the middle changed
        for (let i = start; i < endA; i++) ops.push(["del", i]);
        for (let j = start; j < endB; j++) ops.push(["add", j]);
    } else {
        const dp: Uint32Array[] = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
        for (let i = rows - 1; i >= 0; i--) {
            for (let j = cols - 1; j >= 0; j--) {
                dp[i][j] = a[start + i] === b[start + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < rows || j < cols) {
            if (i < rows && j < cols && a[start + i] === b[start + j]) {
                ops.push(["same", start + i]);
                i++;
                j++;
            } else if (i < rows && (j === cols || dp[i + 1][j] >= dp[i][j + 1])) {
                // removals first: "old → new" reads in that order
                ops.push(["del", start + i]);
                i++;
            } else {
                ops.push(["add", start + j]);
                j++;
            }
        }
    }
    for (let i = endA; i < n; i++) ops.push(["same", i]);
    return ops;
}

/** Word-level segments of a changed line; neighbouring segments of one kind are merged. */
export function diffWords(before: string, after: string): Segment[] {
    const a = before.split(/(\s+)/).filter(Boolean);
    const b = after.split(/(\s+)/).filter(Boolean);
    const out: Segment[] = [];
    for (const [kind, k] of align(a, b)) {
        const text = kind === "add" ? b[k] : a[k];
        const last = out[out.length - 1];
        if (last?.kind === kind) last.text += text;
        else out.push({ kind, text });
    }
    return out;
}

export interface Hunk {
    /** Line number (0-based, in the old text) of the first line of the hunk. */
    line: number;
    /** A changed line as word segments; a removed or added line is one segment. */
    lines: Segment[][];
}

/** The changed lines of a text; a removed line next to an added one is shown as one line with word changes. */
export function diffText(before: string, after: string, maxHunks = 30): { hunks: Hunk[]; more: number } {
    const a = before.split("\n");
    const b = after.split("\n");
    const ops = align(a, b);
    const hunks: Hunk[] = [];
    let line = 0;
    let i = 0;
    let total = 0;
    while (i < ops.length) {
        if (ops[i][0] === "same") {
            line++;
            i++;
            continue;
        }
        const dels: string[] = [];
        const adds: string[] = [];
        const at = line;
        while (i < ops.length && ops[i][0] !== "same") {
            const [kind, k] = ops[i];
            if (kind === "del") {
                dels.push(a[k]);
                line++;
            } else adds.push(b[k]);
            i++;
        }
        total++;
        if (hunks.length >= maxHunks) continue;
        const lines: Segment[][] = [];
        const pairs = Math.min(dels.length, adds.length);
        for (let p = 0; p < pairs; p++) lines.push(diffWords(dels[p], adds[p]));
        for (const d of dels.slice(pairs)) if (d.trim()) lines.push([{ kind: "del", text: d }]);
        for (const x of adds.slice(pairs)) if (x.trim()) lines.push([{ kind: "add", text: x }]);
        if (lines.length) hunks.push({ line: at, lines });
    }
    return { hunks, more: Math.max(0, total - maxHunks) };
}

/** Long unchanged runs inside a line are cut to their ends, so a hunk shows the change and a little around it. */
export function trimSame(segments: Segment[], keep = 60): Segment[] {
    return segments.map((s, i) => {
        if (s.kind !== "same" || s.text.length <= keep * 2 + 1) return s;
        if (i === 0) return { ...s, text: `…${s.text.slice(-keep)}` };
        if (i === segments.length - 1) return { ...s, text: `${s.text.slice(0, keep)}…` };
        return { ...s, text: `${s.text.slice(0, keep)} … ${s.text.slice(-keep)}` };
    });
}
