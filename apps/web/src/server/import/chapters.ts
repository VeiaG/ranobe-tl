import JSZip from "jszip";

export interface ImportedChapter {
    index: number | null;
    source: string;
    name: string;
}

const TEXT_EXT = /\.(txt|md|text)$/i;

/** First number in a file name: "00012.txt", "Chapter 12 - Wind.txt", "vol1/ch-012.txt" → 12. */
export function indexFromName(name: string): number | null {
    const base = name.split("/").pop() ?? name;
    const m = base.replace(/\.[a-z0-9]+$/i, "").match(/(\d+)(?!.*\d)/) ?? base.match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

function normalize(text: string): string {
    return text.replace(/^﻿/, "").replace(/\r\n|\r/g, "\n").trim();
}

/** Turns uploaded files (txt, zip of txt, JSON array) into chapters. */
export async function readUpload(file: File): Promise<ImportedChapter[]> {
    const name = file.name;
    if (/\.zip$/i.test(name)) {
        const zip = await JSZip.loadAsync(await file.arrayBuffer());
        const entries = Object.values(zip.files)
            .filter((f) => !f.dir && TEXT_EXT.test(f.name) && !f.name.split("/").some((p) => p.startsWith(".") || p === "__MACOSX"))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        const out: ImportedChapter[] = [];
        for (const e of entries) out.push({ index: indexFromName(e.name), source: normalize(await e.async("string")), name: e.name });
        return out;
    }
    const text = await file.text();
    if (/\.json$/i.test(name)) {
        const data = JSON.parse(text);
        const list = Array.isArray(data) ? data : Array.isArray(data?.chapters) ? data.chapters : [];
        return list
            .map((c: any, i: number): ImportedChapter | null => {
                const body = typeof c === "string" ? c : (c?.content ?? c?.body ?? c?.text);
                if (typeof body !== "string") return null;
                const title = typeof c?.title === "string" ? c.title.trim() : "";
                const index = Number.isInteger(c?.index) ? c.index : Number.isInteger(c?.id) ? c.id : null;
                const source = normalize(title && !body.trimStart().startsWith(title) ? `${title}\n\n${body}` : body);
                return { index, source, name: `${name}#${i + 1}` };
            })
            .filter((c: ImportedChapter | null): c is ImportedChapter => !!c && !!c.source);
    }
    return [{ index: indexFromName(name), source: normalize(text), name }];
}

/** Splits one long text into chapters at lines like "Chapter 12" / "Chapter 12: Title". */
export function splitByHeadings(text: string): ImportedChapter[] {
    const lines = normalize(text).split("\n");
    const out: ImportedChapter[] = [];
    let current: string[] = [];
    const flush = () => {
        const source = current.join("\n").trim();
        if (source) out.push({ index: indexFromName(source.split("\n")[0]), source, name: source.split("\n")[0].slice(0, 60) });
        current = [];
    };
    for (const line of lines) {
        if (/^\s*(chapter|ch\.|глава|розділ)\s*\d+/i.test(line) && current.some((l) => l.trim())) flush();
        current.push(line);
    }
    flush();
    return out;
}

export function titleOf(source: string): string {
    return source.split("\n").find((l) => l.trim())?.trim().slice(0, 300) ?? "";
}
