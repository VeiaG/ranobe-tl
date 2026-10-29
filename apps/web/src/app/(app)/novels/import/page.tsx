import { ImportForm } from "@/components/novel/import-form";
import { Page, PageHeader } from "@/components/page-header";
import { db } from "@/db";
import { listKeys } from "@/server/queries";
import { storageConfig } from "@/server/storage/client";

export const metadata = { title: "Import a novel" };

export default async function ImportPage() {
    const [keys, storage] = await Promise.all([listKeys(), storageConfig(db)]);
    return (
        <Page className="max-w-3xl">
            <PageHeader title="Import a novel" description="From a backup in the bucket, a folder exported from here, or a novel folder of the old CLI." />
            <div className="mt-8">
                <ImportForm keys={keys} bucketReady={storage.enabled} />
            </div>
        </Page>
    );
}
