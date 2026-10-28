import { DecisionList } from "@/components/decisions";
import { serializeGroups } from "@/server/decision-groups";
import { db } from "@/db";
import { pendingGroups } from "@/server/decisions";
import { getNovel } from "@/server/queries";

export default async function NovelDecisionsPage({ params }: { params: Promise<{ id: string }> }) {
    const id = Number((await params).id);
    const { novel } = await getNovel(id);
    const groups = await pendingGroups(db, id);
    return (
        <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 lg:px-8">
            <DecisionList groups={serializeGroups(groups)} waiting={novel.status === "waiting"} />
        </div>
    );
}
