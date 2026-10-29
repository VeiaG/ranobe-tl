import { DecisionList } from "@/components/decisions";
import { serializeGroups } from "@/server/decision-groups";
import { Page, PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { pendingGroups } from "@/server/decisions";

export const metadata = { title: "Decisions" };

export default async function DecisionsPage() {
    const groups = await pendingGroups(db);
    return (
        <Page className="max-w-4xl">
            <PageHeader title="Decisions" description="Changes the model proposed for terms that are already in a glossary. New terms are added on their own and never show up here." />
            <div className="mt-6">
                <DecisionList groups={serializeGroups(groups)} showNovel />
            </div>
        </Page>
    );
}
