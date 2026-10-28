import { eq } from "drizzle-orm";
import { db } from "@/db";
import { novel } from "@/db/schema";
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
