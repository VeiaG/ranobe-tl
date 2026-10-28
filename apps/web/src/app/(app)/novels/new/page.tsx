import { NovelForm } from "@/components/novel/novel-form";
import { Page, PageHeader } from "@/components/page-header";
import { listKeys } from "@/server/queries";

export const metadata = { title: "New novel" };

export default async function NewNovelPage() {
    const keys = await listKeys();
    return (
        <Page className="max-w-3xl">
            <PageHeader title="New novel" description="Set it up once; chapters come next." />
            <div className="mt-8 rounded-xl border bg-card p-6 shadow-xs">
                <NovelForm keys={keys} />
            </div>
        </Page>
    );
}
