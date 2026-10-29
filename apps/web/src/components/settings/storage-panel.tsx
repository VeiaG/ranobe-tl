"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { CircleAlert, CloudUpload, FolderTree, Loader2, RefreshCw, Zap } from "lucide-react";
import { Field } from "@/components/novel/novel-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { timeAgo } from "@/lib/utils";
import { saveStorage, syncNow, testStorage, type StorageInput } from "@/server/actions/storage";

export interface StorageView {
    enabled: boolean;
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    hasSecret: boolean;
    prefix: string;
    includeSources: boolean;
}

export interface StorageStatusView {
    lastRunAt: string | null;
    uploaded: number;
    novels: number;
    error: string | null;
}

export function StoragePanel({ config, status, isAdmin }: { config: StorageView; status: StorageStatusView; isAdmin: boolean }) {
    const router = useRouter();
    const [enabled, setEnabled] = useState(config.enabled);
    const [includeSources, setIncludeSources] = useState(config.includeSources);
    const [pending, start] = useTransition();
    const [testing, startTest] = useTransition();

    const read = (form: HTMLFormElement): StorageInput => {
        const f = new FormData(form);
        return {
            enabled,
            includeSources,
            endpoint: String(f.get("endpoint") ?? ""),
            region: String(f.get("region") ?? ""),
            bucket: String(f.get("bucket") ?? ""),
            accessKeyId: String(f.get("accessKeyId") ?? ""),
            secret: String(f.get("secret") ?? ""),
            prefix: String(f.get("prefix") ?? ""),
        };
    };

    return (
        <div className="grid gap-4">
            <div className="flex gap-3 rounded-xl border bg-card p-4 text-sm shadow-xs">
                <FolderTree className="mt-0.5 size-4 shrink-0 text-brand" />
                <div className="space-y-1.5 text-muted-foreground">
                    <p>
                        Every novel is kept as a plain folder in an S3-compatible bucket (Cloudflare R2, Backblaze B2, MinIO, AWS S3), the same layout the CLI used:
                    </p>
                    <pre className="rounded-md bg-muted px-3 py-2 font-mono text-xs text-foreground">
                        {`${config.prefix || "ranobe-tl"}/<novel>/novel.json\n${config.prefix || "ranobe-tl"}/<novel>/glossary.json\n${config.prefix || "ranobe-tl"}/<novel>/translation/00001.json\n${config.prefix || "ranobe-tl"}/<novel>/chapters/00001.txt`}
                    </pre>
                    <p>A chapter goes up a minute after it is translated or edited, the glossary after changes, and everything is checked nightly. Only changed files are sent; nothing is deleted in the bucket.</p>
                </div>
            </div>

            {enabled && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card px-4 py-3 text-sm shadow-xs">
                    <CloudUpload className="size-4 text-muted-foreground" />
                    <span className="flex-1">
                        {status.lastRunAt ? (
                            <>
                                Last sync {timeAgo(status.lastRunAt)}: {status.uploaded} files uploaded, {status.novels} novels checked
                            </>
                        ) : (
                            "Not synced yet"
                        )}
                        {status.error && (
                            <span className="mt-1 flex items-center gap-1.5 text-destructive">
                                <CircleAlert className="size-3.5" />
                                {status.error}
                            </span>
                        )}
                    </span>
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                            start(async () => {
                                const res = await syncNow();
                                if (!res.ok) toast.error(res.error);
                                else toast.success(res.message ?? "Queued");
                                setTimeout(() => router.refresh(), 4000);
                            })
                        }
                    >
                        <RefreshCw />
                        Sync now
                    </Button>
                </div>
            )}

            <form
                className="grid gap-5 rounded-xl border bg-card p-6 shadow-xs"
                onSubmit={(e) => {
                    e.preventDefault();
                    const input = read(e.currentTarget);
                    start(async () => {
                        const res = await saveStorage(input);
                        if (!res.ok) toast.error(res.error);
                        else toast.success(res.message ?? "Saved");
                        router.refresh();
                    });
                }}
            >
                <label className="flex items-center justify-between gap-4">
                    <span>
                        <span className="block font-medium">Back up novels to a bucket</span>
                        <span className="block text-sm text-muted-foreground">Translations, glossaries and settings; small and readable without this app.</span>
                    </span>
                    <Switch checked={enabled} onCheckedChange={setEnabled} disabled={!isAdmin} />
                </label>
                <fieldset disabled={!isAdmin} className="grid items-start gap-5 sm:grid-cols-2">
                    <Field label="Endpoint" htmlFor="endpoint" className="sm:col-span-2" hint="R2: https://<account id>.r2.cloudflarestorage.com · MinIO: http://minio:9000">
                        <Input id="endpoint" name="endpoint" defaultValue={config.endpoint} placeholder="https://…r2.cloudflarestorage.com" className="font-mono text-sm" />
                    </Field>
                    <Field label="Bucket" htmlFor="bucket">
                        <Input id="bucket" name="bucket" defaultValue={config.bucket} placeholder="translations" />
                    </Field>
                    <Field label="Region" htmlFor="region" hint="“auto” for R2.">
                        <Input id="region" name="region" defaultValue={config.region} placeholder="auto" />
                    </Field>
                    <Field label="Access key ID" htmlFor="accessKeyId">
                        <Input id="accessKeyId" name="accessKeyId" defaultValue={config.accessKeyId} autoComplete="off" className="font-mono text-sm" />
                    </Field>
                    <Field label="Secret access key" htmlFor="secret" hint={config.hasSecret ? "Saved. Leave empty to keep it." : "Stored encrypted with APP_SECRET."}>
                        <Input id="secret" name="secret" type="password" autoComplete="off" placeholder={config.hasSecret ? "••••••••" : ""} className="font-mono text-sm" />
                    </Field>
                    <Field label="Folder in the bucket" htmlFor="prefix" hint="Changing the place uploads everything again.">
                        <Input id="prefix" name="prefix" defaultValue={config.prefix} className="font-mono text-sm" />
                    </Field>
                    <label className="flex items-center justify-between gap-4 self-end rounded-lg border p-3">
                        <span>
                            <span className="block text-sm font-medium">Include sources</span>
                            <span className="block text-xs text-muted-foreground">chapters/*.txt, to restore the whole novel</span>
                        </span>
                        <Switch checked={includeSources} onCheckedChange={setIncludeSources} />
                    </label>
                </fieldset>
                {isAdmin ? (
                    <div className="flex flex-wrap justify-end gap-2 border-t pt-5">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={testing}
                            onClick={(e) => {
                                const input = read(e.currentTarget.form!);
                                startTest(async () => {
                                    const res = await testStorage(input);
                                    if (!res.ok) toast.error(res.error, { duration: 12000 });
                                    else toast.success(res.message ?? "Works");
                                });
                            }}
                        >
                            {testing ? <Loader2 className="animate-spin" /> : <Zap />}
                            Test connection
                        </Button>
                        <Button type="submit" disabled={pending}>
                            {pending && <Loader2 className="animate-spin" />}
                            Save
                        </Button>
                    </div>
                ) : (
                    <p className="text-sm text-muted-foreground">Only the admin can change storage settings.</p>
                )}
            </form>
        </div>
    );
}
