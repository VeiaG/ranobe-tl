import type { Config } from "../config.js";

export interface SourceCheck {
    ok: boolean;
    reason?: string;
}

export function cleanSource(text: string, config: Config): string {
    let out = text.replace(/\r\n|\r/g, "\n");
    for (const s of config.stringsToRemove) out = out.replaceAll(s, "");
    for (const p of config.patternsToRemove) out = out.replace(new RegExp(p, "gim"), "");
    out = dedupeTitle(out);
    return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Sources often repeat the chapter title on the first lines; keep only the first one. */
/** Title comparison key: no "Chapter 12:" / "Prologue Part 1" prefix, case, punctuation or apostrophe style. */
export function titleKey(line: string): string {
    return line
        .toLowerCase()
        .replace(/^\s*(chapter|ch\.?|prologue|epilogue|side story|extra)\s*(part\s*)?[\d.]*\s*(part\s*\d+)?\s*[:\-–—.]?\s*/u, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

/**
 * Sources often repeat the chapter title on the next lines, either verbatim or
 * without the "Chapter N" prefix ("Chapter 1 I Live Alone (1)" → "I Live Alone (1)").
 * Keep only the first one.
 */
export function dedupeTitle(text: string): string {
    const lines = text.split("\n");
    const firstIdx = lines.findIndex((l) => l.trim());
    if (firstIdx === -1) return text;
    const title = titleKey(lines[firstIdx]);
    const isRepeat = (l: string) => {
        const k = titleKey(l);
        if (!k || !title) return false;
        return k === title || (title.endsWith(` ${k}`) && k.length >= title.length / 2);
    };
    const out = lines.slice(0, firstIdx + 1);
    let i = firstIdx + 1;
    while (i < lines.length && (!lines[i].trim() || isRepeat(lines[i]))) {
        if (!lines[i].trim()) out.push(lines[i]);
        i++;
    }
    return [...out, ...lines.slice(i)].join("\n");
}

export function checkSource(text: string, config: Config): SourceCheck {
    if (/Failed to download chapter body/i.test(text)) return { ok: false, reason: "source download failed" };
    if (text.length < config.validation.minSourceChars) {
        return { ok: false, reason: `source too short (${text.length} < ${config.validation.minSourceChars} chars)` };
    }
    return { ok: true };
}

/**
 * Splits into chunks of at most `size` characters, on paragraph boundaries where possible
 * (then lines, then sentences). Chunks are balanced: a text just over the limit becomes two
 * halves rather than a full chunk plus a tiny tail.
 */
export function chunkText(text: string, size: number): string[] {
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > size) {
        const parts = Math.ceil(rest.length / size);
        const target = Math.ceil(rest.length / parts);
        const window = rest.slice(0, Math.min(size, Math.round(target * 1.2)));
        const cut = findCut(window, target);
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
}

/** The boundary closest to `target`: paragraph, else line, else sentence, else a hard cut. */
function findCut(window: string, target: number): number {
    for (const sep of ["\n\n", "\n", ". "]) {
        let best = -1;
        for (let i = window.indexOf(sep, Math.floor(target / 2)); i !== -1; i = window.indexOf(sep, i + 1)) {
            if (best === -1 || Math.abs(i - target) < Math.abs(best - target)) best = i;
        }
        if (best !== -1) return sep === ". " ? best + 1 : best;
    }
    return window.length;
}
