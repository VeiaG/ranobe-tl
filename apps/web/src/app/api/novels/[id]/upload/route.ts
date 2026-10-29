import { and, eq, inArray, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { chapter, novel } from "@/db/schema";
import { logEvent } from "@/server/activity";
import { readUpload, splitByHeadings, titleOf, type ImportedChapter } from "@/server/import/chapters";
import { requestSync } from "@/server/queue";
import { getSession } from "@/server/session";

export const runtime = "nodejs";

/**
 * Adds source chapters. Form fields: files (txt / zip / json, many), or text (+ split=1 to cut at
 * "Chapter N" headings, or index=N for one chapter); replace=1 overwrites existing sources.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!(await getSession())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const novelId = Number((await params).id);
    const [n] = await db.select({ id: novel.id }).from(novel).where(eq(novel.id, novelId));
    if (!n) return NextResponse.json({ error: "Novel not found" }, { status: 404 });

    const form = await req.formData();
    const replace = form.get("replace") === "1";
    const incoming: ImportedChapter[] = [];
    const problems: string[] = [];
    for (const f of form.getAll("files")) {
        if (!(f instanceof File) || !f.size) continue;
        try {
            incoming.push(...(await readUpload(f)));
        } catch (error) {
            problems.push(`${f.name}: ${error instanceof Error ? error.message : "could not read"}`);
        }
    }
    const text = form.get("text");
    if (typeof text === "string" && text.trim()) {
        if (form.get("split") === "1") incoming.push(...splitByHeadings(text));
        else {
            const index = Number(form.get("index"));
            incoming.push({ index: Number.isInteger(index) && index > 0 ? index : null, source: text.trim(), name: "pasted text" });
        }
    }
    const usable = incoming.filter((c) => c.source.trim());
    if (!usable.length) return NextResponse.json({ error: problems[0] ?? "No chapter text found in the upload" }, { status: 400 });

    // Chapters without a number in the name continue after the highest index.
    const [{ max }] = await db
        .select({ max: sql<number>`coalesce(max(${chapter.index}), 0)::int` })
        .from(chapter)
        .where(eq(chapter.novelId, novelId));
    let next = Math.max(max, ...usable.map((c) => c.index ?? 0)) + 1;
    const seen = new Set<number>();
    const rows = usable.map((c) => {
        let index = c.index && c.index > 0 && !seen.has(c.index) ? c.index : next++;
        while (seen.has(index)) index = next++;
        seen.add(index);
        return { novelId, index, source: c.source, sourceTitle: titleOf(c.source) };
    });

    const existing = new Set(
        (
            await db
                .select({ index: chapter.index })
                .from(chapter)
                .where(and(eq(chapter.novelId, novelId), inArray(chapter.index, rows.map((r) => r.index))))
        ).map((r) => r.index)
    );

    let added = 0;
    let replaced = 0;
    let skipped = 0;
    for (let i = 0; i < rows.length; i += 200) {
        const batch = rows.slice(i, i + 200);
        const fresh = batch.filter((r) => !existing.has(r.index));
        if (fresh.length) {
            await db.insert(chapter).values(fresh);
            added += fresh.length;
        }
        for (const r of batch.filter((r) => existing.has(r.index))) {
            if (!replace) {
                skipped++;
                continue;
            }
            await db
                .update(chapter)
                .set({ source: r.source, sourceTitle: r.sourceTitle })
                .where(and(eq(chapter.novelId, novelId), eq(chapter.index, r.index)));
            replaced++;
        }
    }
    await db.update(novel).set({ updatedAt: new Date() }).where(eq(novel.id, novelId));
    await logEvent(db, novelId, "info", `sources uploaded: ${added} added${replaced ? `, ${replaced} replaced` : ""}${skipped ? `, ${skipped} skipped (already there)` : ""}`);
    await requestSync(novelId);
    return NextResponse.json({ added, replaced, skipped, problems });
}
