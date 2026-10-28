import { and, desc, eq, gt, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { chapter, event, novel } from "@/db/schema";
import { getSession } from "@/server/session";

export const dynamic = "force-dynamic";

/** Polled by the novel pages while a run is active: status, the chapter in flight and new log lines. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!(await getSession())) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const novelId = Number((await params).id);
    const after = Number(new URL(req.url).searchParams.get("after") ?? 0);

    const [n] = await db
        .select({ status: novel.status, statusMessage: novel.statusMessage, updatedAt: novel.updatedAt })
        .from(novel)
        .where(eq(novel.id, novelId));
    if (!n) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const [current] = await db
        .select({ index: chapter.index, title: chapter.sourceTitle })
        .from(chapter)
        .where(and(eq(chapter.novelId, novelId), inArray(chapter.status, ["translating"])))
        .limit(1);
    const events = await db
        .select()
        .from(event)
        .where(and(eq(event.novelId, novelId), gt(event.id, after)))
        .orderBy(desc(event.id))
        .limit(100);

    return NextResponse.json({ ...n, current: current ?? null, events: events.reverse() });
}
