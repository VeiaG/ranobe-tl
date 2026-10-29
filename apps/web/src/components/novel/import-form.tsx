"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { FileArchive, Folder, Loader2, RefreshCw, Upload } from "lucide-react";
import { PROVIDER_DEFAULTS, type Provider } from "@ranobe-tl/core";
import { Field, type KeyOption } from "@/components/novel/novel-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { importFromBucket, listBucketFolders } from "@/server/actions/storage";

export function ImportForm({ keys, bucketReady }: { keys: KeyOption[]; bucketReady: boolean }) {
    const router = useRouter();
    const [tab, setTab] = useState<string>(bucketReady ? "bucket" : "zip");
    const [title, setTitle] = useState("");
    const [keyId, setKeyId] = useState(keys[0] ? String(keys[0].id) : "");
    const [file, setFile] = useState<File | null>(null);
    const [folders, setFolders] = useState<string[] | null>(null);
    const [folder, setFolder] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [loading, startLoading] = useTransition();
    const input = useRef<HTMLInputElement>(null);

    const loadFolders = () =>
        startLoading(async () => {
            const res = await listBucketFolders();
            if (!res.ok) return void toast.error(res.error);
            setFolders(res.data ?? []);
        });

    useEffect(() => {
        if (bucketReady) loadFolders();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bucketReady]);

    const done = (res: { novelId: number; chapters: number; translated: number; terms: number }) => {
        toast.success(`Imported: ${res.chapters} chapters (${res.translated} translated), ${res.terms} terms`);
        router.push(`/novels/${res.novelId}`);
        router.refresh();
    };

    async function submit() {
        setBusy(true);
        try {
            if (tab === "zip") {
                if (!file) return;
                const form = new FormData();
                form.set("file", file);
                form.set("title", title);
                if (keyId) form.set("providerKeyId", keyId);
                const res = await fetch("/api/novels/import", { method: "POST", body: form });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error ?? "Import failed");
                done(data);
            } else {
                if (!folder) return;
                const res = await importFromBucket(folder, { title, providerKeyId: keyId ? Number(keyId) : null });
                if (!res.ok) throw new Error(res.error);
                done(res.data!);
            }
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="grid gap-6 rounded-xl border bg-card p-6 shadow-xs">
            <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
                <TabsList className="w-full">
                    <TabsTrigger value="bucket" disabled={!bucketReady}>
                        From backup
                    </TabsTrigger>
                    <TabsTrigger value="zip">Zip file</TabsTrigger>
                </TabsList>
                <TabsContent value="bucket" className="mt-4">
                    <div className="mb-2 flex items-center justify-between text-sm text-muted-foreground">
                        <span>Novel folders in the bucket</span>
                        <Button variant="ghost" size="xs" onClick={loadFolders} disabled={loading}>
                            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                            Refresh
                        </Button>
                    </div>
                    <div className="scrollbar-thin max-h-72 overflow-y-auto rounded-lg border">
                        {folders === null && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
                        {folders?.length === 0 && <p className="p-4 text-sm text-muted-foreground">The bucket has no novel folders yet.</p>}
                        {folders?.map((f) => (
                            <button
                                key={f}
                                type="button"
                                onClick={() => setFolder(f)}
                                className={cn("flex w-full items-center gap-2.5 border-b px-3 py-2 text-left text-sm last:border-0 hover:bg-muted/50", folder === f && "bg-brand/8 text-brand")}
                            >
                                <Folder className="size-4 shrink-0" />
                                <span className="truncate font-mono">{f}</span>
                            </button>
                        ))}
                    </div>
                </TabsContent>
                <TabsContent value="zip" className="mt-4">
                    <div
                        onClick={() => input.current?.click()}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={(e) => {
                            e.preventDefault();
                            setFile(e.dataTransfer.files[0] ?? null);
                        }}
                        className="flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-10 text-center transition-colors hover:bg-muted/40"
                    >
                        {file ? <FileArchive className="mb-2 size-5 text-brand" /> : <Upload className="mb-2 size-5 text-muted-foreground" />}
                        <div className="text-sm font-medium">{file ? file.name : "Drop a .zip of a novel folder"}</div>
                        <div className="mt-1 max-w-md text-xs text-muted-foreground">
                            The folder holds novel.json, chapters/*.txt and/or translation/*.json, and a glossary: glossary.json from here, or the CLI&apos;s glossary.db / meta.json.
                        </div>
                        <input ref={input} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                    </div>
                </TabsContent>
            </Tabs>
            {!bucketReady && (
                <p className="-mt-2 text-xs text-muted-foreground">
                    To import from a backup bucket, set it up in{" "}
                    <Link href="/settings?tab=storage" className="text-brand hover:underline">
                        Settings → Storage
                    </Link>
                    .
                </p>
            )}
            <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Title" htmlFor="title" hint="Empty: taken from novel.json.">
                    <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
                </Field>
                <Field label="API key">
                    <Select
                        value={keyId}
                        onValueChange={(v) => v && setKeyId(v)}
                        disabled={!keys.length}
                        items={Object.fromEntries(keys.map((k) => [String(k.id), `${k.name} · ${PROVIDER_DEFAULTS[k.provider as Provider]?.label ?? k.provider}`]))}
                    >
                        <SelectTrigger className="w-full">
                            <SelectValue placeholder="Choose later" />
                        </SelectTrigger>
                        <SelectContent>
                            {keys.map((k) => (
                                <SelectItem key={k.id} value={String(k.id)}>
                                    {k.name} · {PROVIDER_DEFAULTS[k.provider as Provider]?.label ?? k.provider}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
            </div>
            <div className="flex justify-end gap-2 border-t pt-5">
                <Button variant="ghost" nativeButton={false} render={<Link href="/novels/new" />}>
                    Cancel
                </Button>
                <Button onClick={submit} disabled={busy || (tab === "zip" ? !file : !folder)}>
                    {busy && <Loader2 className="animate-spin" />}
                    Import
                </Button>
            </div>
        </div>
    );
}
