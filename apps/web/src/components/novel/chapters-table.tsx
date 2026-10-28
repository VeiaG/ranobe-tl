"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { BookOpenText, ChevronLeft, ChevronRight, Download, Languages, Loader2, MoreHorizontal, RotateCcw, Search, Trash2, Upload, X } from "lucide-react";
import { EmptyState } from "@/components/page-header";
import { ChapterStatusLabel } from "@/components/status";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChapterStatus } from "@/db/schema";
import { cn, formatNumber, formatTokens, timeAgo } from "@/lib/utils";
import { deleteChapters, resetChapters } from "@/server/actions/chapters";
import { startRun } from "@/server/actions/run";
import { useLive } from "./live";
import { UploadDialog } from "./upload-dialog";

export interface ChapterRow {
    index: number;
    sourceTitle: string;
    title: string | null;
    status: ChapterStatus;
    attempts: number;
    ratio: number | null;
    error: string;
    chars: number;
    tokens: number;
    duration: number | null;
    translatedAt: string | null;
}

type Filter = "all" | "new" | "queued" | "done" | "failed" | "skipped";

export function ChaptersTable(props: {
    novelId: number;
    running: boolean;
    rows: ChapterRow[];
    total: number;
    page: number;
    pageSize: number;
    status?: ChapterStatus;
    q: string;
    counts: Record<Filter, number>;
    openUpload: boolean;
}) {
    const { novelId, rows, total, page, pageSize, counts } = props;
    const router = useRouter();
    const pathname = usePathname();
    const search = useSearchParams();
    const live = useLive();
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [upload, setUpload] = useState(props.openUpload);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const [q, setQ] = useState(props.q);
    const [pending, start] = useTransition();

    useEffect(() => setSelected(new Set()), [props.status, props.q, page]);
    useEffect(() => {
        const t = setTimeout(() => {
            if (q !== props.q) navigate({ q: q || undefined, page: undefined });
        }, 300);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [q]);

    function navigate(patch: Record<string, string | undefined>) {
        const sp = new URLSearchParams(search.toString());
        sp.delete("upload");
        for (const [k, v] of Object.entries(patch)) v === undefined ? sp.delete(k) : sp.set(k, v);
        router.replace(`${pathname}${sp.size ? `?${sp}` : ""}`, { scroll: false });
    }

    const filters: { key: Filter; label: string }[] = [
        { key: "all", label: "All" },
        { key: "new", label: "Not started" },
        { key: "queued", label: "Queued" },
        { key: "done", label: "Done" },
        { key: "failed", label: "Failed" },
        { key: "skipped", label: "Skipped" },
    ];
    const active: Filter = (props.status as Filter) ?? "all";
    const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.index));
    const someSelected = rows.some((r) => selected.has(r.index));
    const indexes = [...selected];
    const pages = Math.max(1, Math.ceil(total / pageSize));

    const act = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, done?: string) =>
        start(async () => {
            const res = await fn();
            if (!res.ok) return void toast.error(res.error);
            toast.success(res.message ?? done ?? "Done");
            setSelected(new Set());
            live.kick();
            router.refresh();
        });

    if (counts.all === 0) {
        return (
            <>
                <EmptyState icon={Upload} title="No chapters yet" description="Upload .txt files (one per chapter), a zip of them, a JSON array, or paste a long text and split it at chapter headings.">
                    <Button onClick={() => setUpload(true)}>
                        <Upload />
                        Upload chapters
                    </Button>
                </EmptyState>
                <UploadDialog novelId={novelId} open={upload} onOpenChange={setUpload} />
            </>
        );
    }

    return (
        <div className="grid gap-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="scrollbar-thin flex gap-1 overflow-x-auto rounded-lg bg-muted p-[3px]">
                    {filters.map((f) => (
                        <button
                            key={f.key}
                            onClick={() => navigate({ status: f.key === "all" ? undefined : f.key, page: undefined })}
                            className={cn(
                                "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground",
                                active === f.key && "bg-background text-foreground shadow-sm dark:bg-input/30"
                            )}
                        >
                            {f.label}
                            <span className="text-xs tabular-nums opacity-70">{formatNumber(counts[f.key])}</span>
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-2">
                    <div className="relative flex-1 lg:w-64 lg:flex-none">
                        <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number or title" className="pl-8" />
                    </div>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="icon" aria-label="Export">
                                <Download />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                                <a href={`/api/novels/${novelId}/export?format=txt`}>Zip of .txt files</a>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <a href={`/api/novels/${novelId}/export?format=json`}>Zip of .json (CLI format)</a>
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <a href={`/api/novels/${novelId}/export?format=single`}>One .txt with everything</a>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <Button onClick={() => setUpload(true)}>
                        <Upload />
                        <span className="hidden sm:inline">Upload</span>
                    </Button>
                </div>
            </div>

            {someSelected && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2 text-sm animate-in fade-in-0 slide-in-from-top-1">
                    <span className="font-medium">{selected.size} selected</span>
                    <Button variant="ghost" size="xs" onClick={() => setSelected(new Set())}>
                        <X />
                        Clear
                    </Button>
                    <div className="ml-auto flex flex-wrap gap-2">
                        <Button size="sm" disabled={pending} onClick={() => act(() => startRun(novelId, { kind: "chapters", indexes }))}>
                            {pending ? <Loader2 className="animate-spin" /> : <Languages />}
                            Translate
                        </Button>
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => act(() => resetChapters(novelId, indexes), "Translations removed")}>
                            <RotateCcw />
                            Reset
                        </Button>
                        <Button size="sm" variant="outline" className="text-destructive" disabled={pending || props.running} onClick={() => setConfirmDelete(true)}>
                            <Trash2 />
                            Delete
                        </Button>
                    </div>
                </div>
            )}

            <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
                <Table>
                    <TableHeader>
                        <TableRow className="hover:bg-transparent">
                            <TableHead className="w-10 pl-4">
                                <Checkbox
                                    checked={allSelected ? true : someSelected ? "indeterminate" : false}
                                    onCheckedChange={(v) => setSelected(v === true ? new Set(rows.map((r) => r.index)) : new Set())}
                                    aria-label="Select all"
                                />
                            </TableHead>
                            <TableHead className="w-16">#</TableHead>
                            <TableHead>Title</TableHead>
                            <TableHead className="w-32">Status</TableHead>
                            <TableHead className="hidden w-24 text-right md:table-cell">Length</TableHead>
                            <TableHead className="hidden w-24 text-right lg:table-cell">Tokens</TableHead>
                            <TableHead className="hidden w-28 text-right sm:table-cell">Translated</TableHead>
                            <TableHead className="w-12" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                                    No chapters match.
                                </TableCell>
                            </TableRow>
                        )}
                        {rows.map((r) => {
                            const href = `/novels/${novelId}/chapters/${r.index}`;
                            const isCurrent = live.current?.index === r.index;
                            const status: ChapterStatus = isCurrent ? "translating" : r.status;
                            return (
                                <TableRow key={r.index} data-state={selected.has(r.index) ? "selected" : undefined} className={cn(isCurrent && "bg-brand/5")}>
                                    <TableCell className="pl-4">
                                        <Checkbox
                                            checked={selected.has(r.index)}
                                            onCheckedChange={(v) =>
                                                setSelected((s) => {
                                                    const next = new Set(s);
                                                    v === true ? next.add(r.index) : next.delete(r.index);
                                                    return next;
                                                })
                                            }
                                            aria-label={`Select chapter ${r.index}`}
                                        />
                                    </TableCell>
                                    <TableCell className="font-mono text-xs text-muted-foreground">{r.index}</TableCell>
                                    <TableCell className="max-w-0 whitespace-normal">
                                        <Link href={href} className="block truncate font-medium hover:text-brand">
                                            {r.title || r.sourceTitle || `Chapter ${r.index}`}
                                        </Link>
                                        {r.title && <div className="truncate text-xs text-muted-foreground">{r.sourceTitle}</div>}
                                        {r.error && (r.status === "failed" || r.status === "skipped") && <div className="truncate text-xs text-destructive/90">{r.error}</div>}
                                    </TableCell>
                                    <TableCell>
                                        {r.error && r.status === "failed" ? (
                                            <Tooltip>
                                                <TooltipTrigger>
                                                    <ChapterStatusLabel status={status} />
                                                </TooltipTrigger>
                                                <TooltipContent className="max-w-sm">{r.error}</TooltipContent>
                                            </Tooltip>
                                        ) : (
                                            <ChapterStatusLabel status={status} />
                                        )}
                                    </TableCell>
                                    <TableCell className="hidden text-right text-xs text-muted-foreground tabular-nums md:table-cell">
                                        {formatNumber(Math.round(r.chars / 100) / 10)}k
                                    </TableCell>
                                    <TableCell className="hidden text-right text-xs text-muted-foreground tabular-nums lg:table-cell">{r.tokens ? formatTokens(r.tokens) : "—"}</TableCell>
                                    <TableCell className="hidden text-right text-xs text-muted-foreground sm:table-cell">{r.translatedAt ? timeAgo(r.translatedAt) : "—"}</TableCell>
                                    <TableCell className="pr-3 text-right">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button variant="ghost" size="icon-xs" aria-label="Actions">
                                                    <MoreHorizontal />
                                                </Button>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end">
                                                <DropdownMenuItem asChild>
                                                    <Link href={href}>
                                                        <BookOpenText />
                                                        Open
                                                    </Link>
                                                </DropdownMenuItem>
                                                <DropdownMenuItem onSelect={() => act(() => startRun(novelId, { kind: "chapters", indexes: [r.index] }))}>
                                                    <Languages />
                                                    {r.status === "done" ? "Translate again" : "Translate"}
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuItem variant="destructive" disabled={props.running} onSelect={() => act(() => deleteChapters(novelId, [r.index]), "Chapter deleted")}>
                                                    <Trash2 />
                                                    Delete
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </div>

            {pages > 1 && (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                        {formatNumber((page - 1) * pageSize + 1)}–{formatNumber(Math.min(page * pageSize, total))} of {formatNumber(total)}
                    </span>
                    <div className="flex gap-1">
                        <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => navigate({ page: String(page - 1) })} aria-label="Previous page">
                            <ChevronLeft />
                        </Button>
                        <Button variant="outline" size="icon-sm" disabled={page >= pages} onClick={() => navigate({ page: String(page + 1) })} aria-label="Next page">
                            <ChevronRight />
                        </Button>
                    </div>
                </div>
            )}

            <UploadDialog novelId={novelId} open={upload} onOpenChange={setUpload} />
            <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete {selected.size} chapters?</AlertDialogTitle>
                        <AlertDialogDescription>Their source text and translations are removed. The glossary stays as it is.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction variant="destructive" onClick={() => act(() => deleteChapters(novelId, indexes), "Chapters deleted")}>
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}
