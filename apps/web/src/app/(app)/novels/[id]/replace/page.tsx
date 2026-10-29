import { and, count, eq } from "drizzle-orm";
import { ReplacePanel } from "@/components/novel/replace-panel";
import { db } from "@/db";
import { chapter } from "@/db/schema";
import { getNovel } from "@/server/queries";

export default async function ReplacePage({ params }: { params: Promise<{ id: string }> }) {
    const id = Number((await params).id);
    await getNovel(id);
    const [{ done }] = await db
        .select({ done: count() })
        .from(chapter)
        .where(and(eq(chapter.novelId, id), eq(chapter.status, "done")));
    return (
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
            <ReplacePanel novelId={id} chapters={done} />
        </div>
    );
}
