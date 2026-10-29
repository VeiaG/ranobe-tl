import { and, asc, eq } from "drizzle-orm";
import JSZip from "jszip";
import { db } from "@/db";
import { chapter, novel } from "@/db/schema";
import { getSession } from "@/server/session";
import { novelFolder, slugify } from "@/server/storage/folder";

/** Translated chapters as a zip: one .txt per chapter (title on the first line) plus the CLI's .json format. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!(await getSession())) return new Response("Not signed in", { status: 401 });
    const novelId = Number((await params).id);
    const format = new URL(req.url).searchParams.get("format") ?? "txt";
    const [n] = await db.select().from(novel).where(eq(novel.id, novelId));
    if (!n) return new Response("Not found", { status: 404 });
    const rows = await db
        .select({ index: chapter.index, title: chapter.title, content: chapter.content })
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), eq(chapter.status, "done")))
        .orderBy(asc(chapter.index));

    if (format === "folder") {
        // the same layout as the backup: novel.json, glossary.json, translation/, chapters/
        const folder = new JSZip();
        const name = n.storageFolder ?? slugify(n.title);
        for (const [p, body] of await novelFolder(db, novelId)) folder.file(`${name}/${p}`, body);
        const data = await folder.generateAsync({ type: "uint8array", compression: "DEFLATE" });
        return new Response(data as BodyInit, {
            headers: {
                "content-type": "application/zip",
                "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.zip`)}`,
            },
        });
    }
    const zip = new JSZip();
    const pad = Math.max(5, String(rows.at(-1)?.index ?? 0).length);
    for (const r of rows) {
        const name = String(r.index).padStart(pad, "0");
        if (format === "json") zip.file(`${name}.json`, JSON.stringify({ content: r.content ?? "", title: r.title ?? "" }, null, 2));
        else zip.file(`${name}.txt`, `${r.title ?? ""}\n\n${r.content ?? ""}\n`);
    }
    if (format === "single") {
        const book = rows.map((r) => `${r.title ?? ""}\n\n${r.content ?? ""}`).join("\n\n\n");
        return new Response(book, {
            headers: {
                "content-type": "text/plain; charset=utf-8",
                "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${n.title}.txt`)}`,
            },
        });
    }
    const data = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return new Response(data as BodyInit, {
        headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${n.title} (${format}).zip`)}`,
        },
    });
}
