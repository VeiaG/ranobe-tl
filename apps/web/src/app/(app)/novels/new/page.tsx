import Link from "next/link";
import { FolderInput } from "lucide-react";
import { NovelForm } from "@/components/novel/novel-form";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/page-header";
import { listKeys } from "@/server/queries";

export const metadata = { title: "New novel" };

export default async function NewNovelPage() {
    const keys = await listKeys();
    return (
        <Page className="max-w-3xl">
            <PageHeader
                title="New novel"
                description="Set it up once; chapters come next."
                actions={
                    <Button variant="outline" nativeButton={false} render={<Link href="/novels/import" />}>
                        <FolderInput />
                        Import a folder
                    </Button>
                }
            />
            <div className="mt-8 rounded-xl border bg-card p-6 shadow-xs">
                <NovelForm keys={keys} />
            </div>
        </Page>
    );
}
