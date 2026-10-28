"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
    ArrowLeft,
    ChevronLeft,
    ChevronRight,
    CircleAlert,
    Columns2,
    FileText,
    Languages,
    Loader2,
    Lock,
    Minus,
    Pencil,
    Plus,
    ScrollText,
    Terminal,
} from "lucide-react";
import { ChapterStatusLabel } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import type { ChapterStatus } from "@/db/schema";
import { cn, formatTokens, timeAgo } from "@/lib/utils";
import { saveTranslation } from "@/server/actions/chapters";
import { HistoryDialog, type VersionView } from "./history-dialog";
import { startRun } from "@/server/actions/run";

interface ReaderTerm {
    id: number;
    source: string;
    target: string;
    type: string;
    note: string;
    locked: boolean;
    gender: string | null;
}

interface Exchange {
    id: number;
    chunk: number;
    attempt: number;
    prompt: string;
    output: string;
    createdAt: string;
}

interface ReaderChapter {
    index: number;
    status: ChapterStatus;
    source: string;
    sourceTitle: string;
    title: string | null;
    content: string | null;
    error: string;
    model: string;
    attempts: number;
    ratio: number | null;
    tokens: number;
    duration: number | null;
    translatedAt: string | null;
}

type Mode = "translation" | "parallel" | "source";

const NAME_TYPES = new Set(["person", "place", "organization"]);

function paragraphs(text: string): string[] {
    return text
        .split(/\n\s*\n+/)
        .map((p) => p.trim())
        .filter(Boolean);
}

/** The source without its title line (the translation keeps the title separately). */
function sourceBody(source: string): string {
    const lines = source.split("\n");
    const first = lines.findIndex((l) => l.trim());
    return lines.slice(first + 1).join("\n").trim();
}

function escapeRe(s: string) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wraps glossary terms found in a source paragraph. */
function useHighlighter(terms: ReaderTerm[]) {
    return useMemo(() => {
        if (!terms.length) return (text: string) => [text] as React.ReactNode[];
        const byKey = new Map(terms.map((t) => [t.source.toLowerCase(), t]));
        const sorted = [...terms].sort((a, b) => b.source.length - a.source.length);
        const re = new RegExp(`(?<![\\p{L}\\p{N}])(${sorted.map((t) => escapeRe(t.source)).join("|")})((?:'s|’s|es|s)?)(?![\\p{L}\\p{N}])`, "giu");
        return (text: string) => {
            const out: React.ReactNode[] = [];
            let last = 0;
            for (const m of text.matchAll(re)) {
                const t = byKey.get(m[1].toLowerCase());
                if (!t) continue;
                // a single capitalized name is only that name when capitalized ("White" vs "a white wall")
                if (NAME_TYPES.has(t.type) && !/\s/.test(t.source) && /^\p{Lu}/u.test(t.source) && !/^\p{Lu}/u.test(m[1])) continue;
                if (m.index! > last) out.push(text.slice(last, m.index));
                out.push(<TermMark key={`${m.index}-${t.id}`} term={t} text={m[0]} />);
                last = m.index! + m[0].length;
            }
            if (last < text.length) out.push(text.slice(last));
            return out;
        };
    }, [terms]);
}

function TermMark({ term, text }: { term: ReaderTerm; text: string }) {
    return (
        <Popover>
            <PopoverTrigger render={<span className="cursor-pointer rounded-[3px] bg-brand/10 underline decoration-brand/40 decoration-dotted underline-offset-4 hover:bg-brand/20" />}>{text}</PopoverTrigger>
            <PopoverContent className="w-64 p-3 font-sans" side="top">
                <div className="flex items-start justify-between gap-2">
                    <div className="text-sm font-medium">{term.source}</div>
                    <Badge variant="muted">{term.type}</Badge>
                </div>
                <div className="mt-1 text-base text-brand">{term.target}</div>
                <div className="mt-2 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                    {term.gender && term.gender !== "unknown" && <span>{term.gender === "m" ? "male" : "female"} here</span>}
                    {term.locked && (
                        <span className="flex items-center gap-1">
                            <Lock className="size-3" />
                            locked
                        </span>
                    )}
                </div>
                {term.note && <p className="mt-1.5 text-xs text-muted-foreground">{term.note}</p>}
            </PopoverContent>
        </Popover>
    );
}

export function Reader({
    novelId,
    novelTitle,
    chapter: c,
    prev,
    next,
    terms,
    exchanges,
    versions,
}: {
    novelId: number;
    novelTitle: string;
    chapter: ReaderChapter;
    prev: number | null;
    next: number | null;
    terms: ReaderTerm[];
    exchanges: Exchange[];
    versions: VersionView[];
}) {
    const router = useRouter();
    const [mode, setMode] = useState<Mode>(c.content ? "translation" : "source");
    const [size, setSize] = useState(17);
    const [editing, setEditing] = useState(false);
    const [showLog, setShowLog] = useState(false);
    const [pending, start] = useTransition();
    const highlight = useHighlighter(terms);

    useEffect(() => {
        try {
            const saved = JSON.parse(localStorage.getItem("reader") ?? "{}");
            if (saved.size) setSize(saved.size);
            if (saved.mode && (c.content || saved.mode === "source")) setMode(saved.mode);
        } catch {}
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        try {
            localStorage.setItem("reader", JSON.stringify({ size, mode }));
        } catch {}
    }, [size, mode]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (editing || (e.target as HTMLElement)?.closest("input, textarea")) return;
            if (e.key === "ArrowLeft" && prev !== null) router.push(`/novels/${novelId}/chapters/${prev}`);
            if (e.key === "ArrowRight" && next !== null) router.push(`/novels/${novelId}/chapters/${next}`);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [editing, prev, next, novelId, router]);

    const src = useMemo(() => paragraphs(sourceBody(c.source)), [c.source]);
    const tl = useMemo(() => paragraphs(c.content ?? ""), [c.content]);
    const rows = Math.max(src.length, tl.length);

    const retranslate = () =>
        start(async () => {
            const res = await startRun(novelId, { kind: "chapters", indexes: [c.index] });
            if (!res.ok) toast.error(res.error);
            else toast.success("Chapter queued");
            router.refresh();
        });

    const textStyle = { fontSize: `${size}px` };

    return (
        <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
            <div className="sticky top-0 z-20 -mx-4 mb-6 flex flex-wrap items-center gap-2 border-b bg-background/85 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
                <Button variant="ghost" size="sm" className="-ml-2" nativeButton={false} render={<Link href={`/novels/${novelId}/chapters`} />}>
                        <ArrowLeft />
                        <span className="hidden sm:inline">Chapters</span>
                    </Button>
                <div className="flex items-center">
                    {prev !== null ? (
                        <Button variant="ghost" size="icon-sm" aria-label="Previous chapter" nativeButton={false} render={<Link href={`/novels/${novelId}/chapters/${prev}`} />}>
                            <ChevronLeft />
                        </Button>
                    ) : (
                        <Button variant="ghost" size="icon-sm" disabled aria-label="Previous chapter">
                            <ChevronLeft />
                        </Button>
                    )}
                    <span className="min-w-14 text-center font-mono text-sm tabular-nums">#{c.index}</span>
                    {next !== null ? (
                        <Button variant="ghost" size="icon-sm" aria-label="Next chapter" nativeButton={false} render={<Link href={`/novels/${novelId}/chapters/${next}`} />}>
                            <ChevronRight />
                        </Button>
                    ) : (
                        <Button variant="ghost" size="icon-sm" disabled aria-label="Next chapter">
                            <ChevronRight />
                        </Button>
                    )}
                </div>
                <div className="flex rounded-lg bg-muted p-[3px]">
                    {(
                        [
                            { m: "translation", icon: FileText, label: "Translation", disabled: !c.content },
                            { m: "parallel", icon: Columns2, label: "Side by side", disabled: !c.content },
                            { m: "source", icon: ScrollText, label: "Original" },
                        ] as const
                    ).map(({ m, icon: Icon, label, ...rest }) => (
                        <button
                            key={m}
                            disabled={"disabled" in rest && rest.disabled}
                            onClick={() => setMode(m)}
                            className={cn(
                                "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
                                mode === m && "bg-background text-foreground shadow-sm dark:bg-input/30"
                            )}
                        >
                            <Icon className="size-3.5" />
                            <span className="hidden md:inline">{label}</span>
                        </button>
                    ))}
                </div>
                <div className="ml-auto flex items-center gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => setSize((s) => Math.max(13, s - 1))} aria-label="Smaller text">
                        <Minus />
                    </Button>
                    <span className="w-6 text-center text-xs text-muted-foreground tabular-nums">{size}</span>
                    <Button variant="ghost" size="icon-sm" onClick={() => setSize((s) => Math.min(24, s + 1))} aria-label="Larger text">
                        <Plus />
                    </Button>
                    <HistoryDialog novelId={novelId} index={c.index} current={{ title: c.title, content: c.content }} versions={versions} />
                    {c.content && (
                        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                            <Pencil />
                            <span className="hidden sm:inline">Edit</span>
                        </Button>
                    )}
                    <Button variant="outline" size="sm" disabled={pending || c.status === "queued" || c.status === "translating"} onClick={retranslate}>
                        {pending ? <Loader2 className="animate-spin" /> : <Languages />}
                        <span className="hidden sm:inline">{c.content ? "Translate again" : "Translate"}</span>
                    </Button>
                </div>
            </div>

            <header className={cn("mx-auto mb-8", mode === "parallel" ? "max-w-none" : "max-w-[42rem]")}>
                <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>{novelTitle}</span>
                    <ChapterStatusLabel status={c.status} />
                    {c.translatedAt && <span>translated {timeAgo(c.translatedAt)}</span>}
                    {c.model && <span className="font-mono">{c.model}</span>}
                    {c.tokens > 0 && <span>{formatTokens(c.tokens)} tokens</span>}
                    {c.ratio !== null && <span>length ×{c.ratio.toFixed(2)}</span>}
                    {exchanges.length > 0 && (
                        <button onClick={() => setShowLog(true)} className="flex items-center gap-1 hover:text-foreground">
                            <Terminal className="size-3" />
                            {exchanges.length} {exchanges.length === 1 ? "request" : "requests"}
                        </button>
                    )}
                </div>
                <h1 className="font-serif text-3xl leading-tight font-semibold tracking-tight text-balance">
                    {mode === "source" ? c.sourceTitle : c.title || c.sourceTitle}
                </h1>
                {mode !== "source" && c.title && <p className="mt-1 text-sm text-muted-foreground">{c.sourceTitle}</p>}
                {c.error && (c.status === "failed" || c.status === "skipped") && (
                    <div className="mt-4 flex gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
                        <div>
                            <div className="font-medium text-destructive">{c.status === "failed" ? "The translation failed" : "Skipped"}</div>
                            <div className="mt-0.5 text-muted-foreground">{c.error}</div>
                        </div>
                    </div>
                )}
            </header>

            {mode === "translation" && (
                <article className="reader-text mx-auto max-w-[42rem] font-serif leading-[1.75]" style={textStyle}>
                    {tl.map((p, i) => (
                        <p key={i}>{p}</p>
                    ))}
                </article>
            )}

            {mode === "source" && (
                <article className="reader-text mx-auto max-w-[42rem] font-serif leading-[1.75]" style={textStyle}>
                    {src.map((p, i) => (
                        <p key={i}>{highlight(p)}</p>
                    ))}
                </article>
            )}

            {mode === "parallel" && (
                <div className="font-serif leading-[1.7]" style={{ fontSize: `${size - 1}px` }}>
                    {src.length !== tl.length && (
                        <p className="mb-4 font-sans text-xs text-muted-foreground">
                            {src.length} paragraphs in the original, {tl.length} in the translation: rows may drift apart.
                        </p>
                    )}
                    <div className="hidden grid-cols-2 gap-x-10 border-b pb-2 font-sans text-xs font-medium text-muted-foreground md:grid">
                        <span>Original</span>
                        <span>Translation</span>
                    </div>
                    {Array.from({ length: rows }, (_, i) => (
                        <div key={i} className="group grid gap-x-10 gap-y-1 border-b border-dashed border-border/60 py-3 md:grid-cols-2">
                            <p className="text-muted-foreground group-hover:text-foreground/80">{src[i] ? highlight(src[i]) : ""}</p>
                            <p>{tl[i] ?? ""}</p>
                        </div>
                    ))}
                </div>
            )}

            {!c.content && mode !== "source" && <p className="text-center text-muted-foreground">Not translated yet.</p>}

            <nav className="mx-auto mt-14 flex max-w-[42rem] items-center justify-between border-t pt-6">
                {prev !== null ? (
                    <Button variant="outline" nativeButton={false} render={<Link href={`/novels/${novelId}/chapters/${prev}`} />}>
                            <ChevronLeft />
                            Chapter {prev}
                        </Button>
                ) : (
                    <span />
                )}
                {next !== null && (
                    <Button variant="outline" nativeButton={false} render={<Link href={`/novels/${novelId}/chapters/${next}`} />}>
                            Chapter {next}
                            <ChevronRight />
                        </Button>
                )}
            </nav>

            <EditDialog open={editing} onOpenChange={setEditing} novelId={novelId} chapter={c} />
            <Dialog open={showLog} onOpenChange={setShowLog}>
                <DialogContent className="sm:max-w-4xl">
                    <DialogHeader>
                        <DialogTitle>Model requests</DialogTitle>
                        <DialogDescription>Prompts and raw answers of the last translation of this chapter.</DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4">
                        {exchanges.map((e) => (
                            <details key={e.id} className="rounded-lg border">
                                <summary className="cursor-pointer px-3 py-2 text-sm">
                                    Part {e.chunk + 1}, attempt {e.attempt}
                                    <span className="ml-2 text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleTimeString()}</span>
                                </summary>
                                <div className="grid gap-3 border-t p-3 md:grid-cols-2">
                                    <pre className="scrollbar-thin max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{e.prompt}</pre>
                                    <pre className="scrollbar-thin max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{e.output}</pre>
                                </div>
                            </details>
                        ))}
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}

function EditDialog({ open, onOpenChange, novelId, chapter }: { open: boolean; onOpenChange: (v: boolean) => void; novelId: number; chapter: ReaderChapter }) {
    const router = useRouter();
    const [title, setTitle] = useState(chapter.title ?? "");
    const [content, setContent] = useState(chapter.content ?? "");
    const [pending, start] = useTransition();
    useEffect(() => {
        if (open) {
            setTitle(chapter.title ?? "");
            setContent(chapter.content ?? "");
        }
    }, [open, chapter.title, chapter.content]);
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-3xl">
                <DialogHeader>
                    <DialogTitle>Edit translation</DialogTitle>
                    <DialogDescription>Paragraphs are separated by an empty line. A new translation of the chapter replaces your edits.</DialogDescription>
                </DialogHeader>
                <Input value={title} onChange={(e) => setTitle(e.target.value)} className="font-serif text-base" />
                <Textarea value={content} onChange={(e) => setContent(e.target.value)} className="h-[55vh] font-serif text-[15px] leading-relaxed [field-sizing:fixed]" />
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        disabled={pending}
                        onClick={() =>
                            start(async () => {
                                const res = await saveTranslation(novelId, chapter.index, { title, content });
                                if (!res.ok) return void toast.error(res.error);
                                toast.success("Saved");
                                onOpenChange(false);
                                router.refresh();
                            })
                        }
                    >
                        {pending && <Loader2 className="animate-spin" />}
                        Save
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
