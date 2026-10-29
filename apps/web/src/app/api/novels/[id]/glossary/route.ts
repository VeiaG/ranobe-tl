import { eq } from "drizzle-orm";
import { db } from "@/db";
import { novel } from "@/db/schema";
import { logEvent } from "@/server/activity";
import { describeMerge, forSequel, glossaryFromFile, glossaryOfNovel, mergeGlossary, novelTitle } from "@/server/glossary-seed";
import { requestSync } from "@/server/queue";
import { getSession } from "@/server/session";
import { glossaryJson } from "@/server/storage/folder";

/** The glossary as JSON (terms, past decisions, ignored sources); the import reads it back. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!(await getSession())) return new Response("Not signed in", { status: 401 });
    const novelId = Number((await params).id);
    const [n] = await db.select({ title: novel.title }).from(novel).where(eq(novel.id, novelId));
    if (!n) return new Response("Not found", { status: 404 });
    return new Response(await glossaryJson(db, novelId), {
        headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${n.title} glossary.json`)}`,
        },
    });
}

/**
 * Adds terms to the glossary: from a file (glossary.json, an array, the CLI's meta.json or glossary.db),
 * pasted JSON, or another novel. sequel=1 treats the source as an earlier part (see forSequel).
 * Terms the novel already has are kept as they are.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!(await getSession())) return Response.json({ error: "Not signed in" }, { status: 401 });
    const novelId = Number((await params).id);
    if (!(await novelTitle(db, novelId))) return Response.json({ error: "Not found" }, { status: 404 });
    try {
        const form = await req.formData();
        const file = form.get("file");
        const text = form.get("text");
        const fromNovel = Number(form.get("fromNovel"));
        let glossary;
        let from: string;
        if (Number.isInteger(fromNovel) && fromNovel > 0) {
            if (fromNovel === novelId) throw new Error("Choose another novel");
            from = (await novelTitle(db, fromNovel)) ?? "";
            if (!from) throw new Error("That novel is gone");
            glossary = await glossaryOfNovel(db, fromNovel);
        } else if (file instanceof File && file.size) {
            from = file.name;
            glossary = await glossaryFromFile(file.name, new Uint8Array(await file.arrayBuffer()));
        } else if (typeof text === "string" && text.trim()) {
            from = "pasted JSON";
            glossary = await glossaryFromFile("pasted.json", new TextEncoder().encode(text));
        } else {
            throw new Error("Choose a file, paste JSON or pick a novel");
        }
        const result = await mergeGlossary(db, novelId, form.get("sequel") === "1" ? forSequel(glossary) : glossary);
        const message = describeMerge(result, from);
        await logEvent(db, novelId, "info", message);
        await requestSync(novelId);
        return Response.json({ ...result, message });
    } catch (error) {
        return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
}
