import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { z } from "zod";
import { DECISION_MODES, PIPELINES } from "@/db/schema";
import { TERM_TYPES, normalizeTerm, parseLegacyValue, type Gender, type TermType } from "@ranobe-tl/core";
import type { DB } from "@/db";
import { chapter, ignoredTerm, novel, term, termChange, termGender } from "@/db/schema";
import { NovelSettingsSchema } from "../novel-config";
import { indexFromName, titleOf } from "../import/chapters";
import type { Bucket } from "./client";
import { GLOSSARY_FORMAT } from "./folder";

/** File path (relative to the novel folder) → content. */
export type FolderFiles = Map<string, Uint8Array>;

const decoder = new TextDecoder();
const text = (b: Uint8Array) => decoder.decode(b).replace(/^﻿/, "").replace(/\r\n|\r/g, "\n");

/** A zip of a novel folder; a single top-level directory inside it is stripped. */
export async function filesFromZip(data: ArrayBuffer | Uint8Array): Promise<FolderFiles> {
    const zip = await JSZip.loadAsync(data);
    const entries = Object.values(zip.files).filter((f) => !f.dir && !f.name.split("/").some((p) => p.startsWith(".") || p === "__MACOSX"));
    const roots = new Set(entries.map((f) => (f.name.includes("/") ? f.name.split("/")[0] : "")));
    const strip = roots.size === 1 && !roots.has("") && !entries.some((f) => f.name.split("/")[0] === "novel.json") ? `${[...roots][0]}/` : "";
    const files: FolderFiles = new Map();
    for (const e of entries) files.set(e.name.slice(strip.length), await e.async("uint8array"));
    return files;
}

/** Every file of a novel folder in the backup bucket. */
export async function filesFromBucket(bucket: Bucket, folder: string): Promise<FolderFiles> {
    const base = folder.replace(/\/+$/, "") + "/";
    const { files: list } = await bucket.list(base);
    const files: FolderFiles = new Map();
    let i = 0;
    await Promise.all(
        Array.from({ length: 6 }, async () => {
            while (i < list.length) {
                const f = list[i++];
                const data = await bucket.get(f.path);
                if (data) files.set(f.path.slice(base.length), data);
            }
        })
    );
    return files;
}

const CliConfig = z
    .object({
        model: z.string().optional(),
        sourceLanguage: z.string().optional(),
        targetLanguage: z.string().optional(),
        inputFolder: z.string().optional(),
        outputFolder: z.string().optional(),
        novel: z.object({ title: z.string().optional(), synopsis: z.string().optional() }).optional(),
        ranobeTl: z
            .object({
                title: z.string().optional(),
                originalTitle: z.string().optional(),
                decisionMode: z.enum(DECISION_MODES).optional(),
                pipeline: z.enum(PIPELINES).optional(),
                askNew: z.object({ types: z.array(z.enum(TERM_TYPES)).optional(), untilChapter: z.number().optional() }).nullable().optional(),
            })
            .optional(),
    })
    .passthrough();

export interface GlossaryTerm {
    source: string;
    target: string;
    type: TermType;
    note: string;
    locked: boolean;
    firstChapter: number | null;
    genders: { fromChapter: number; gender: Gender }[];
}

export interface GlossaryChange {
    source: string;
    field: string;
    oldValue: string;
    newValue: string;
    chapter: number | null;
    status: string;
    reason: string;
    evidence: string;
}

export interface Glossary {
    terms: GlossaryTerm[];
    changes: GlossaryChange[];
    ignored: string[];
}

const asType = (t: unknown): TermType => ((TERM_TYPES as readonly string[]).includes(String(t)) ? (t as TermType) : "other");
const asGender = (g: unknown): Gender | undefined => (g === "m" || g === "f" || g === "unknown" ? g : undefined);

/** glossary.json: this app's format, a plain array of terms, or the CLI's old flat meta.json. */
export function parseGlossaryJson(raw: unknown): Glossary {
    const out: Glossary = { terms: [], changes: [], ignored: [] };
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as any).terms) ? (raw as any).terms : null;
    if (list) {
        for (const t of list) {
            if (!t || typeof t.source !== "string" || typeof t.target !== "string" || !t.source.trim()) continue;
            const type = asType(t.type);
            const genders = Array.isArray(t.genders)
                ? t.genders.flatMap((g: any) => (asGender(g?.gender) && Number.isInteger(g?.fromChapter) ? [{ fromChapter: g.fromChapter, gender: asGender(g.gender)! }] : []))
                : [];
            const firstChapter = Number.isInteger(t.firstChapter) ? t.firstChapter : null;
            if (!genders.length && type === "person") genders.push({ fromChapter: firstChapter ?? 1, gender: asGender(t.gender) ?? "unknown" });
            out.terms.push({ source: t.source.trim(), target: t.target.trim(), type, note: String(t.note ?? ""), locked: !!t.locked, firstChapter, genders });
        }
        if ((raw as any)?.format === GLOSSARY_FORMAT) {
            for (const c of (raw as any).changes ?? []) {
                if (typeof c?.source !== "string" || (c.field !== "target" && c.field !== "gender")) continue;
                out.changes.push({
                    source: c.source,
                    field: c.field,
                    oldValue: String(c.oldValue ?? ""),
                    newValue: String(c.newValue ?? ""),
                    chapter: Number.isInteger(c.chapter) ? c.chapter : null,
                    status: ["applied", "pending", "rejected"].includes(c.status) ? c.status : "applied",
                    reason: String(c.reason ?? ""),
                    evidence: String(c.evidence ?? ""),
                });
            }
            out.ignored = ((raw as any).ignored ?? []).filter((s: unknown) => typeof s === "string");
        }
        return out;
    }
    if (raw && typeof raw === "object") {
        for (const [source, value] of Object.entries(raw)) {
            if (typeof value !== "string") continue;
            const e = parseLegacyValue(source, value);
            if (!e.target) continue;
            out.terms.push({ ...e, locked: false, firstChapter: null, genders: e.type === "person" ? [{ fromChapter: 1, gender: e.gender ?? "unknown" }] : [] });
        }
    }
    return out;
}

/** The CLI's glossary.db (SQLite): terms with gender history, decisions, chapter statuses. */
export async function readCliDatabase(data: Uint8Array): Promise<{ glossary: Glossary; chapters: Map<number, { status: string; error: string; model: string }> }> {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(path.join(tmpdir(), "ranobe-import-"));
    const file = path.join(dir, "glossary.db");
    writeFileSync(file, data);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
        const all = (sql: string) => {
            try {
                return db.prepare(sql).all() as Record<string, any>[];
            } catch {
                return [];
            }
        };
        const genders = new Map<number, { fromChapter: number; gender: Gender }[]>();
        for (const g of all("SELECT * FROM genders ORDER BY from_chapter")) {
            const gender = asGender(g.gender);
            if (gender) genders.set(g.term_id, [...(genders.get(g.term_id) ?? []), { fromChapter: g.from_chapter, gender }]);
        }
        const sources = new Map<number, string>();
        const glossary: Glossary = { terms: [], changes: [], ignored: [] };
        for (const t of all("SELECT * FROM terms ORDER BY id")) {
            sources.set(t.id, t.source);
            glossary.terms.push({
                source: t.source,
                target: t.target,
                type: asType(t.type),
                note: t.note ?? "",
                locked: !!t.locked,
                firstChapter: t.first_chapter ?? null,
                genders: genders.get(t.id) ?? [],
            });
        }
        for (const c of all("SELECT * FROM changes ORDER BY id")) {
            const source = sources.get(c.term_id);
            if (!source) continue;
            glossary.changes.push({
                source,
                field: c.field,
                oldValue: c.old_value ?? "",
                newValue: c.new_value ?? "",
                chapter: c.chapter ?? null,
                status: c.status,
                reason: c.reason ?? "",
                evidence: c.evidence ?? "",
            });
        }
        const chapters = new Map<number, { status: string; error: string; model: string }>();
        for (const r of all("SELECT * FROM chapters")) chapters.set(r.idx, { status: r.status, error: r.error ?? "", model: r.model ?? "" });
        return { glossary, chapters };
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
}

export interface ImportResult {
    novelId: number;
    chapters: number;
    translated: number;
    terms: number;
}

/**
 * Creates a novel from a folder: this app's backup layout or a CLI novel folder
 * (novel.json, chapters/*.txt, translation/*.json, glossary.db or meta.json).
 */
export async function importNovelFolder(
    db: DB,
    files: FolderFiles,
    opts: { title?: string; providerKeyId?: number | null; createdBy?: string | null; fallbackTitle?: string }
): Promise<ImportResult> {
    const get = (p: string) => files.get(p);
    const configRaw = get("novel.json");
    let config: z.infer<typeof CliConfig> = {};
    if (configRaw) {
        const parsed = CliConfig.safeParse(JSON.parse(text(configRaw)));
        if (!parsed.success) throw new Error("novel.json could not be read");
        config = parsed.data;
    }
    const inputFolder = (config.inputFolder ?? "chapters").replace(/^\.?\/+|\/+$/g, "");
    const outputFolder = (config.outputFolder ?? "translation").replace(/^\.?\/+|\/+$/g, "");

    let glossary: Glossary = { terms: [], changes: [], ignored: [] };
    let cliChapters = new Map<number, { status: string; error: string; model: string }>();
    if (get("glossary.json")) glossary = parseGlossaryJson(JSON.parse(text(get("glossary.json")!)));
    else if (get("glossary.db")) ({ glossary, chapters: cliChapters } = await readCliDatabase(get("glossary.db")!));
    else if (get("meta.json")) glossary = parseGlossaryJson(JSON.parse(text(get("meta.json")!)));

    const sources = new Map<number, string>();
    const translations = new Map<number, { title: string; content: string }>();
    for (const [p, data] of files) {
        const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
        const index = indexFromName(p);
        if (index === null) continue;
        if (dir === inputFolder && /\.(txt|md)$/i.test(p)) sources.set(index, text(data).trim());
        if (dir === outputFolder && /\.json$/i.test(p)) {
            try {
                const j = JSON.parse(text(data));
                if (typeof j.content === "string" && j.content) translations.set(index, { title: String(j.title ?? ""), content: j.content });
            } catch {
                // a broken file is skipped, not the whole import
            }
        }
    }
    const indexes = [...new Set([...sources.keys(), ...translations.keys()])].sort((a, b) => a - b);
    if (!indexes.length) throw new Error(`No chapters found: expected ${inputFolder}/*.txt or ${outputFolder}/*.json`);

    const extra = NovelSettingsSchema.safeParse(config);
    const settings = extra.success ? extra.data : {};
    const title = opts.title?.trim() || config.ranobeTl?.title || config.novel?.title || opts.fallbackTitle || "Imported novel";

    return db.transaction(async (tx) => {
        const [n] = await tx
            .insert(novel)
            .values({
                title,
                originalTitle: config.ranobeTl?.originalTitle ?? (config.novel?.title && config.novel.title !== title ? config.novel.title : ""),
                synopsis: config.novel?.synopsis ?? "",
                sourceLanguage: config.sourceLanguage ?? "English",
                targetLanguage: config.targetLanguage ?? "Ukrainian",
                model: config.model ?? "",
                providerKeyId: opts.providerKeyId ?? null,
                decisionMode: config.ranobeTl?.decisionMode ?? "queue",
                pipeline: config.ranobeTl?.pipeline ?? "classic",
                askNew: config.ranobeTl?.askNew ?? null,
                settings,
                createdBy: opts.createdBy ?? null,
            })
            .returning({ id: novel.id });

        const rows = indexes.map((index) => {
            const source = sources.get(index) ?? "";
            const t = translations.get(index);
            const cli = cliChapters.get(index);
            const status = t ? "done" : cli?.status === "failed" || cli?.status === "skipped" ? cli.status : "new";
            return {
                novelId: n.id,
                index,
                source,
                sourceTitle: titleOf(source),
                status: status as "done" | "failed" | "skipped" | "new",
                title: t?.title ?? null,
                content: t?.content ?? null,
                error: !t && cli ? cli.error : "",
                model: cli?.model ?? (t ? "imported" : ""),
                translatedAt: t ? new Date() : null,
            };
        });
        for (let i = 0; i < rows.length; i += 200) await tx.insert(chapter).values(rows.slice(i, i + 200));

        const ids = new Map<string, number>();
        for (const t of glossary.terms) {
            const norm = normalizeTerm(t.source);
            if (ids.has(norm)) continue;
            const [row] = await tx
                .insert(term)
                .values({ novelId: n.id, source: t.source, sourceNorm: norm, target: t.target, type: t.type, note: t.note, locked: t.locked, firstChapter: t.firstChapter })
                .returning({ id: term.id });
            ids.set(norm, row.id);
            if (t.genders.length) await tx.insert(termGender).values(t.genders.map((g) => ({ termId: row.id, ...g })));
        }
        const changes = glossary.changes.flatMap((c) => {
            const termId = ids.get(normalizeTerm(c.source));
            return termId ? [{ novelId: n.id, termId, field: c.field, oldValue: c.oldValue, newValue: c.newValue, chapter: c.chapter, status: c.status, reason: c.reason, evidence: c.evidence, decidedAt: c.status === "pending" ? null : new Date() }] : [];
        });
        for (let i = 0; i < changes.length; i += 200) await tx.insert(termChange).values(changes.slice(i, i + 200));
        const ignored = [...new Map(glossary.ignored.map((s) => [normalizeTerm(s), s])).entries()];
        if (ignored.length) await tx.insert(ignoredTerm).values(ignored.map(([sourceNorm, source]) => ({ novelId: n.id, sourceNorm, source })));

        return { novelId: n.id, chapters: rows.length, translated: translations.size, terms: ids.size };
    });
}
