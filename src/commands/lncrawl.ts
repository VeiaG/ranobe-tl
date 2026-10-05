import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import chalk from "chalk";
import { CONFIG_FILE, CONFIG_TEMPLATE } from "../config.js";

interface NovelRow {
    id: string;
    title: string;
    synopsis: string | null;
    language: string | null;
    downloaded: number;
}

/** Where lightnovel-crawler (GUI / server mode) keeps its data. */
export function lncrawlDataDir(explicit?: string): string {
    const candidates = [
        explicit,
        process.env.LNCRAWL_DATA_PATH,
        process.env.APPDATA && path.join(process.env.APPDATA, "LNCrawl"),
        path.join(os.homedir(), ".lncrawl"),
        path.join(os.homedir(), "Library", "Application Support", "LNCrawl"),
    ].filter((p): p is string => !!p);
    const found = candidates.find((p) => existsSync(path.join(p, "sqlite.db")));
    if (!found) throw new Error(`lightnovel-crawler data not found (looked in: ${candidates.join(", ")}). Pass --lncrawl-dir`);
    return found;
}

export function htmlToText(html: string): string {
    return html
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, "\n\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&amp;/g, "&")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function listNovels(db: DatabaseSync): NovelRow[] {
    return db
        .prepare(
            `SELECT n.id, n.title, n.synopsis, n.language, SUM(c.is_done) AS downloaded
             FROM novels n JOIN chapters c ON c.novel_id = n.id
             GROUP BY n.id HAVING downloaded > 0 ORDER BY MAX(c.updated_at) DESC`
        )
        .all() as unknown as NovelRow[];
}

/**
 * `ranobe-tl lncrawl`                → list downloaded novels
 * `ranobe-tl lncrawl <title or id>`  → unpack its chapters into ./chapters as NNNNN.txt
 */
export async function lncrawlCommand(
    root: string,
    query: string,
    opts: { lncrawlDir?: string; force?: boolean; pad?: number }
): Promise<void> {
    const dataDir = lncrawlDataDir(opts.lncrawlDir);
    const db = new DatabaseSync(path.join(dataDir, "sqlite.db"), { readOnly: true });
    try {
        const novels = listNovels(db);
        if (!query) {
            console.log(chalk.dim(`data: ${dataDir}`));
            for (const n of novels) console.log(`${n.title} ${chalk.dim(`(${n.downloaded} chapters, ${n.id})`)}`);
            return;
        }

        const q = query.toLowerCase();
        const matches = novels.filter((n) => n.id === query || n.title.toLowerCase().includes(q));
        if (matches.length !== 1) {
            throw new Error(
                matches.length
                    ? `"${query}" matches several novels:\n${matches.map((n) => `  ${n.title} (${n.id})`).join("\n")}`
                    : `no downloaded novel matches "${query}" (run "ranobe-tl lncrawl" to list them)`
            );
        }
        const novel = matches[0];
        const chapters = db
            .prepare("SELECT serial, title FROM chapters WHERE novel_id = ? AND is_done = 1 ORDER BY serial")
            .all(novel.id) as unknown as { serial: number; title: string }[];

        const pad = opts.pad ?? 5;
        const srcDir = path.join(dataDir, "novels", novel.id, "chapters");
        const outDir = path.join(root, "chapters");
        await fs.mkdir(outDir, { recursive: true });

        let written = 0;
        let skipped = 0;
        const missing: number[] = [];
        for (const ch of chapters) {
            const out = path.join(outDir, `${String(ch.serial).padStart(pad, "0")}.txt`);
            if (!opts.force && existsSync(out)) {
                skipped++;
                continue;
            }
            const file = path.join(srcDir, `${String(ch.serial).padStart(6, "0")}.zst`);
            if (!existsSync(file)) {
                missing.push(ch.serial);
                continue;
            }
            const html = zstdDecompressSync(await fs.readFile(file)).toString("utf-8");
            await fs.writeFile(out, `${ch.title.trim()}\n\n${htmlToText(html)}\n`, "utf-8");
            written++;
        }

        console.log(chalk.green(`${novel.title}: ${written} chapters written to ${outDir}, ${skipped} already existed`));
        if (missing.length) console.log(chalk.yellow(`content files missing for chapters: ${missing.join(",")}`));

        const configFile = path.join(root, CONFIG_FILE);
        if (!existsSync(configFile) && chapters.length) {
            const config = {
                ...CONFIG_TEMPLATE,
                range: { start: chapters[0].serial, end: chapters.at(-1)!.serial },
                novel: { title: novel.title, synopsis: novel.synopsis ? htmlToText(novel.synopsis) : "" },
            };
            await fs.writeFile(configFile, JSON.stringify(config, null, 4) + "\n", "utf-8");
            console.log(chalk.green(`created ${CONFIG_FILE} (range ${config.range.start}-${config.range.end})`));
        }
    } finally {
        db.close();
    }
}
