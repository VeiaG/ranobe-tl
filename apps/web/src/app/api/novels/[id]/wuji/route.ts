import { and, asc, between, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { chapter } from "@/db/schema";
import { getSession } from "@/server/session";
import { markdownToLexical, wujiFetch } from "@/server/wuji";

export const dynamic = "force-dynamic";

const Input = z.object({
    token: z.string().min(1),
    bookId: z.string().min(1),
    from: z.number().int().min(1),
    to: z.number().int().min(1),
});

export type WujiProgress =
    | { type: "start"; total: number; untranslated: number[] }
    | { type: "chapter"; index: number; title: string; done: number }
    | { type: "error"; message: string; index?: number }
    | { type: "done"; uploaded: number };

/**
 * Appends translated chapters to a book on wuji.world, one at a time and in order (the site orders
 * chapters as they are created). Progress comes back as JSON lines; closing the dialog stops it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
    if (!(await getSession())) return Response.json({ error: "Not signed in" }, { status: 401 });
    const novelId = Number((await params).id);
    const parsed = Input.safeParse(await req.json());
    if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message ?? "Bad request" }, { status: 400 });
    const { token, bookId } = parsed.data;
    const [from, to] = [Math.min(parsed.data.from, parsed.data.to), Math.max(parsed.data.from, parsed.data.to)];

    const inRange = and(eq(chapter.novelId, novelId), between(chapter.index, from, to));
    const [rows, untranslated] = await Promise.all([
        db
            .select({ index: chapter.index, title: chapter.title, content: chapter.content })
            .from(chapter)
            .where(and(inRange, eq(chapter.status, "done")))
            .orderBy(asc(chapter.index)),
        db.select({ index: chapter.index }).from(chapter).where(and(inRange, ne(chapter.status, "done"))).orderBy(asc(chapter.index)),
    ]);

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            // once the client is gone the stream is closed and enqueue throws
            const send = (p: WujiProgress) => {
                if (!req.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(p)}\n`));
            };
            send({ type: "start", total: rows.length, untranslated: untranslated.map((r) => r.index) });
            let uploaded = 0;
            for (const r of rows) {
                if (req.signal.aborted) break;
                const title = r.title?.trim() || `Chapter ${r.index}`;
                try {
                    await wujiFetch("/bookChapters", {
                        token,
                        method: "POST",
                        body: { title, book: bookId, content: markdownToLexical(r.content ?? "") },
                        signal: req.signal,
                    });
                } catch (error) {
                    send({ type: "error", index: r.index, message: error instanceof Error ? error.message : String(error) });
                    break;
                }
                uploaded++;
                send({ type: "chapter", index: r.index, title, done: uploaded });
            }
            send({ type: "done", uploaded });
            if (!req.signal.aborted) controller.close();
        },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
