import { and, count, eq } from "drizzle-orm";
import { ReplaceTabs } from "@/components/novel/replace-tabs";
import { db } from "@/db";
import { chapter } from "@/db/schema";
import { getNovel } from "@/server/queries";

export default async function ReplacePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ mode?: string; task?: string }> }) {
    const id = Number((await params).id);
    const sp = await searchParams;
    await getNovel(id);
    const [{ done }] = await db
        .select({ done: count() })
        .from(chapter)
        .where(and(eq(chapter.novelId, id), eq(chapter.status, "done")));
    return (
        <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
            <ReplaceTabs novelId={id} chapters={done} mode={sp.mode === "assistant" ? "assistant" : "replace"} task={sp.task} />
        </div>
    );
}
