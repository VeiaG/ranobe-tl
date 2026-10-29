import Link from "next/link";
import { FolderInput } from "lucide-react";
import { NovelForm } from "@/components/novel/novel-form";
import { Button } from "@/components/ui/button";
import { Page, PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { instanceConfig } from "@/server/instance";
import { listKeys, listNovels } from "@/server/queries";

export const metadata = { title: "New novel" };

export default async function NewNovelPage() {
    const [keys, { defaults }, novels] = await Promise.all([listKeys(), instanceConfig(db), listNovels()]);
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
                <NovelForm
                    keys={keys}
                    novels={novels.filter((n) => n.terms > 0).map((n) => ({ id: n.id, title: n.title, terms: n.terms }))}
                    initial={{
                        sourceLanguage: defaults.sourceLanguage,
                        targetLanguage: defaults.targetLanguage,
                        providerKeyId: defaults.providerKeyId,
                        model: defaults.model,
                        decisionMode: defaults.decisionMode,
                        askNew: defaults.askNew,
                    }}
                />
            </div>
        </Page>
    );
}
