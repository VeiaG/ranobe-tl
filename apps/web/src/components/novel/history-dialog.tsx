"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { diffWordsWithSpace } from "diff";
import { toast } from "sonner";
import { History, Loader2, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn, timeAgo } from "@/lib/utils";
import { restoreVersion } from "@/server/actions/chapters";

export interface VersionView {
    id: number;
    title: string | null;
    content: string;
    model: string;
    translatedAt: string | null;
    replacedBy: string;
    createdAt: string;
}

/** Unchanged stretches longer than this are shortened to their ends. */
const KEEP_CONTEXT = 160;

const REPLACED: Record<string, string> = {
    translation: "replaced by a new translation",
    edit: "replaced by a hand edit",
    reset: "removed by a reset",
    restore: "replaced by a restore",
};

/** The first / last `n` characters of a text, cut at a word boundary. */
function head(text: string, n: number) {
    const cut = text.slice(0, n);
    const space = cut.search(/\s\S*$/);
    return space > n / 2 ? cut.slice(0, space) : cut;
}
function tail(text: string, n: number) {
    const cut = text.slice(-n);
    const space = cut.search(/\s/);
    return space >= 0 && space < n / 2 ? cut.slice(space) : cut;
}

function DiffView({ before, after }: { before: string; after: string }) {
    const parts = useMemo(() => diffWordsWithSpace(before, after), [before, after]);
    const stats = useMemo(() => {
        const words = (s: string) => s.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
        return {
            added: parts.filter((p) => p.added).reduce((a, p) => a + words(p.value), 0),
            removed: parts.filter((p) => p.removed).reduce((a, p) => a + words(p.value), 0),
        };
    }, [parts]);
    return (
        <div className="grid gap-3">
            <div className="flex gap-3 text-xs">
                <span className="text-success">+{stats.added} words</span>
                <span className="text-destructive">−{stats.removed} words</span>
                {!stats.added && !stats.removed && <span className="text-muted-foreground">same text</span>}
            </div>
            <div className="scrollbar-thin max-h-[55vh] overflow-y-auto rounded-lg border bg-background p-4 font-serif text-[15px] leading-relaxed whitespace-pre-wrap">
                {parts.map((p, i) => {
                    if (p.added) return <ins key={i} className="rounded-sm bg-success/15 text-foreground no-underline decoration-success/60">{p.value}</ins>;
                    if (p.removed) return <del key={i} className="rounded-sm bg-destructive/12 text-muted-foreground decoration-destructive/60">{p.value}</del>;
                    if (p.value.length <= KEEP_CONTEXT * 2 + 40) return <span key={i}>{p.value}</span>;
                    // long unchanged text: keep its ends for context
                    return (
                        <span key={i}>
                            {i > 0 && head(p.value, KEEP_CONTEXT)}
                            <span className="mx-1 inline-block rounded bg-muted px-1.5 font-sans text-[11px] text-muted-foreground">⋯ unchanged ⋯</span>
                            {i < parts.length - 1 && tail(p.value, KEEP_CONTEXT)}
                        </span>
                    );
                })}
            </div>
        </div>
    );
}

export function HistoryDialog({ novelId, index, current, versions }: { novelId: number; index: number; current: { title: string | null; content: string | null }; versions: VersionView[] }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState<number | null>(versions[0]?.id ?? null);
    const [pending, start] = useTransition();
    const v = versions.find((x) => x.id === selected) ?? versions[0];

    if (!versions.length) return null;
    return (
        <>
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
                <History />
                <span className="hidden sm:inline">History</span>
                <Badge variant="muted" className="h-4 px-1.5">
                    {versions.length}
                </Badge>
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="sm:max-w-5xl">
                    <DialogHeader>
                        <DialogTitle>Earlier translations</DialogTitle>
                        <DialogDescription>What changed between a saved version and the text now. The last {versions.length >= 10 ? 10 : "few"} versions are kept.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 md:grid-cols-[15rem_1fr]">
                        <ul className="scrollbar-thin grid max-h-[60vh] content-start gap-1 overflow-y-auto">
                            {versions.map((x) => (
                                <li key={x.id}>
                                    <button
                                        onClick={() => setSelected(x.id)}
                                        className={cn("w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50", v?.id === x.id && "border-brand/50 bg-brand/8")}
                                    >
                                        <div className="font-medium">{x.translatedAt ? new Date(x.translatedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "earlier"}</div>
                                        <div className="truncate font-mono text-[11px] text-muted-foreground">{x.model || "—"}</div>
                                        <div className="text-[11px] text-muted-foreground">
                                            {REPLACED[x.replacedBy] ?? x.replacedBy} {timeAgo(x.createdAt)}
                                        </div>
                                    </button>
                                </li>
                            ))}
                        </ul>
                        {v && (
                            <div className="grid content-start gap-3">
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="text-sm">
                                        <span className="text-muted-foreground">This version → now</span>
                                        {v.title !== current.title && (
                                            <div className="text-xs text-muted-foreground">
                                                title: <span className="line-through">{v.title}</span> → {current.title}
                                            </div>
                                        )}
                                    </div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={pending}
                                        onClick={() =>
                                            start(async () => {
                                                const res = await restoreVersion(novelId, index, v.id);
                                                if (!res.ok) return void toast.error(res.error);
                                                toast.success(res.message ?? "Restored");
                                                setOpen(false);
                                                router.refresh();
                                            })
                                        }
                                    >
                                        {pending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                                        Restore this version
                                    </Button>
                                </div>
                                <DiffView before={v.content} after={current.content ?? ""} />
                            </div>
                        )}
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
