import { eq } from "drizzle-orm";
import { db } from "@/db";
import { novel } from "@/db/schema";
import { PgGlossaryStore } from "@/server/glossary-store";
import { getSession } from "@/server/session";

/** The glossary as a JSON array, the same shape the import accepts. */
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!(await getSession())) return new Response("Not signed in", { status: 401 });
    const novelId = Number((await params).id);
    const [n] = await db.select({ title: novel.title }).from(novel).where(eq(novel.id, novelId));
    if (!n) return new Response("Not found", { status: 404 });
    const terms = await new PgGlossaryStore(db, novelId).allTerms();
    const out = terms.map((t) => ({
        source: t.source,
        target: t.target,
        type: t.type,
        note: t.note,
        locked: t.locked,
        firstChapter: t.firstChapter,
        gender: t.genders.at(-1)?.gender,
        genders: t.genders.length > 1 ? t.genders : undefined,
    }));
    return new Response(JSON.stringify(out, null, 2), {
        headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${n.title} glossary.json`)}`,
        },
    });
}
