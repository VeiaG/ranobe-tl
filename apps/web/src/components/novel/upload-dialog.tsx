"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { FileArchive, FileText, Loader2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export function UploadDialog({ novelId, open, onOpenChange }: { novelId: number; open: boolean; onOpenChange: (v: boolean) => void }) {
    const router = useRouter();
    const [files, setFiles] = useState<File[]>([]);
    const [drag, setDrag] = useState(false);
    const [tab, setTab] = useState("files");
    const [text, setText] = useState("");
    const [index, setIndex] = useState("");
    const [split, setSplit] = useState(true);
    const [replace, setReplace] = useState(false);
    const [busy, setBusy] = useState(false);
    const input = useRef<HTMLInputElement>(null);

    function add(list: FileList | null) {
        if (!list) return;
        setFiles((prev) => {
            const names = new Set(prev.map((f) => f.name));
            return [...prev, ...Array.from(list).filter((f) => !names.has(f.name))].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        });
    }

    async function submit() {
        const form = new FormData();
        if (tab === "files") files.forEach((f) => form.append("files", f));
        else {
            form.set("text", text);
            if (split) form.set("split", "1");
            else if (index) form.set("index", index);
        }
        if (replace) form.set("replace", "1");
        setBusy(true);
        try {
            const res = await fetch(`/api/novels/${novelId}/upload`, { method: "POST", body: form });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error ?? "Upload failed");
            toast.success(`${data.added} chapters added${data.replaced ? `, ${data.replaced} replaced` : ""}${data.skipped ? `, ${data.skipped} already existed` : ""}`);
            for (const p of data.problems ?? []) toast.warning(p);
            setFiles([]);
            setText("");
            onOpenChange(false);
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
        } finally {
            setBusy(false);
        }
    }

    const totalSize = files.reduce((a, f) => a + f.size, 0);
    const ready = tab === "files" ? files.length > 0 : text.trim().length > 0;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>Add source chapters</DialogTitle>
                    <DialogDescription>The first line of each chapter is its title. The chapter number comes from the file name (00012.txt, Chapter 12.txt).</DialogDescription>
                </DialogHeader>
                <Tabs value={tab} onValueChange={setTab}>
                    <TabsList className="w-full">
                        <TabsTrigger value="files">Files</TabsTrigger>
                        <TabsTrigger value="text">Paste text</TabsTrigger>
                    </TabsList>
                    <TabsContent value="files" className="mt-3 grid gap-3">
                        <div
                            onDragOver={(e) => {
                                e.preventDefault();
                                setDrag(true);
                            }}
                            onDragLeave={() => setDrag(false)}
                            onDrop={(e) => {
                                e.preventDefault();
                                setDrag(false);
                                add(e.dataTransfer.files);
                            }}
                            onClick={() => input.current?.click()}
                            className={cn(
                                "flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-4 py-8 text-center transition-colors hover:bg-muted/40",
                                drag && "border-brand bg-brand/5"
                            )}
                        >
                            <Upload className="mb-2 size-5 text-muted-foreground" />
                            <div className="text-sm font-medium">Drop files here or click to choose</div>
                            <div className="mt-1 text-xs text-muted-foreground">.txt files, a .zip of them, or a JSON array of chapters</div>
                            <input ref={input} type="file" multiple accept=".txt,.md,.zip,.json,text/plain,application/zip,application/json" className="hidden" onChange={(e) => add(e.target.files)} />
                        </div>
                        {files.length > 0 && (
                            <div className="rounded-lg border">
                                <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
                                    <span>
                                        {files.length} files · {(totalSize / 1024 / 1024).toFixed(totalSize > 1024 * 1024 ? 1 : 2)} MB
                                    </span>
                                    <button className="hover:text-foreground" onClick={() => setFiles([])}>
                                        Clear
                                    </button>
                                </div>
                                <ul className="scrollbar-thin max-h-44 overflow-y-auto py-1 text-sm">
                                    {files.map((f) => (
                                        <li key={f.name} className="flex items-center gap-2 px-3 py-1">
                                            {/\.zip$/i.test(f.name) ? <FileArchive className="size-4 text-muted-foreground" /> : <FileText className="size-4 text-muted-foreground" />}
                                            <span className="min-w-0 flex-1 truncate">{f.name}</span>
                                            <span className="text-xs text-muted-foreground tabular-nums">{Math.ceil(f.size / 1024)} KB</span>
                                            <button onClick={() => setFiles((p) => p.filter((x) => x !== f))} className="text-muted-foreground hover:text-foreground" aria-label="Remove">
                                                <X className="size-3.5" />
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </TabsContent>
                    <TabsContent value="text" className="mt-3 grid gap-3">
                        <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder={"Chapter 1: The Beginning\n\nText of the chapter…"} className="h-56 font-mono text-xs [field-sizing:fixed]" />
                        <label className="flex items-center gap-2 text-sm">
                            <Checkbox checked={split} onCheckedChange={(v) => setSplit(v === true)} />
                            Split into chapters at lines starting with “Chapter N”
                        </label>
                        {!split && (
                            <div className="grid max-w-40 gap-1.5">
                                <Label htmlFor="chapter-index">Chapter number</Label>
                                <Input id="chapter-index" type="number" min={1} value={index} onChange={(e) => setIndex(e.target.value)} placeholder="next free" />
                            </div>
                        )}
                    </TabsContent>
                </Tabs>
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Checkbox checked={replace} onCheckedChange={(v) => setReplace(v === true)} />
                    Replace the source of chapters that already exist
                </label>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={submit} disabled={!ready || busy}>
                        {busy ? <Loader2 className="animate-spin" /> : <Upload />}
                        Add chapters
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
