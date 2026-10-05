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
export function dedupeTitle(text: string): string {
    const lines = text.split("\n");
    const firstIdx = lines.findIndex((l) => l.trim());
    if (firstIdx === -1) return text;
    const key = (l: string) => l.trim().toLowerCase().replace(/[–—-]/g, "-").replace(/\s+/g, " ");
    const title = key(lines[firstIdx]);
    const out = lines.slice(0, firstIdx + 1);
    let i = firstIdx + 1;
    while (i < lines.length && (!lines[i].trim() || key(lines[i]) === title)) {
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

/** Splits on paragraph boundaries, falling back to lines and sentences. */
export function chunkText(text: string, size: number): string[] {
    const chunks: string[] = [];
    let rest = text;
    while (rest.length > size) {
        const window = rest.slice(0, size);
        let cut = window.lastIndexOf("\n\n");
        if (cut < size * 0.3) cut = window.lastIndexOf("\n");
        if (cut < size * 0.3) {
            const sentence = window.lastIndexOf(". ");
            cut = sentence > 0 ? sentence + 1 : size;
        }
        chunks.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks;
}
