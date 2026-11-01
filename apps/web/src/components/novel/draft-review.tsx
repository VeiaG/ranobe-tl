"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Columns2, ExternalLink, FileDiff, Loader2, Rows3, Undo2, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import type { Segment } from "@/lib/diff";
import { cn, plural } from "@/lib/utils";
import { applyDraftChanges, discardDraftChanges, getDraftChanges } from "@/server/actions/assistant";
import type { DraftChange } from "@/server/assistant-draft";

type View = "inline" | "split";
type Filter = "all" | "picked" | "conflicts";

const del = "rounded-[3px] bg-destructive/15 text-destructive line-through decoration-destructive/50";
const add = "rounded-[3px] bg-success/15 text-success";

/** Word segments; `side` keeps only what one side of a split view shows. */
function Segments({ segments, side }: { segments: Segment[]; side?: "before" | "after" }) {
    // a rewritten line (nothing in common): the old one above the new one
    if (!side && segments.length === 2 && segments[0].kind === "del" && segments[1].kind === "add") {
        return (
            <span className="grid gap-1">
                <span>
                    <span className={del}>{segments[0].text}</span>
                </span>
                <span>
                    <span className={add}>{segments[1].text}</span>
                </span>
            </span>
        );
    }
    return (
        <>
            {segments.map((s, i) => {
                if (s.kind === "same") return <span key={i}>{s.text}</span>;
                if (side === "before" && s.kind === "add") return null;
                if (side === "after" && s.kind === "del") return null;
                return (
                    <span key={i} className={cn(s.kind === "del" ? (side ? "rounded-[3px] bg-destructive/15 text-destructive" : del) : add)}>
                        {s.text}
                    </span>
                );
            })}
        </>
    );
}

/** What a changed line was / becomes: removed lines have no "after", added ones no "before". */
const hasSide = (l: Segment[], side: "before" | "after") => l.some((s) => s.kind === "same" || s.kind === (side === "before" ? "del" : "add"));

function Context({ text }: { text?: string }) {
    if (!text) return null;
    return <p className="text-muted-foreground/70">{text}</p>;
}

function ChapterDiff({ change, view, novelId }: { change: DraftChange; view: View; novelId: number }) {
    return (
        <div className="mx-auto grid max-w-5xl gap-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid gap-1">
                    <p className="text-xs text-muted-foreground tabular-nums">Chapter {change.chapter}</p>
                    <h2 className="font-heading text-xl leading-tight font-semibold">{change.currentTitle}</h2>
                    <p className="text-xs text-muted-foreground">
                        <span className="text-destructive tabular-nums">−{change.removed}</span> <span className="text-success tabular-nums">+{change.added}</span> words
                        {change.hunks.length > 0 && ` · ${plural(change.hunks.length + change.moreHunks, "place")} in the text`}
                    </p>
                </div>
                <Button size="sm" variant="outline" nativeButton={false} render={<Link href={`/novels/${novelId}/chapters/${change.chapter}`} target="_blank" />}>
                    <ExternalLink />
                    Open chapter
                </Button>
            </div>

            {change.conflict && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    This chapter was translated or edited again after the draft was made. Applying it is refused, so that change is not lost; discard it here and ask the assistant to redo it.
                </div>
            )}

            {change.title && (
                <section className="grid gap-2">
                    <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Title</h3>
                    {view === "split" ? (
                        <div className="grid grid-cols-2 gap-3">
                            <p className="rounded-lg border bg-destructive/[0.03] p-3 font-medium">
                                <Segments segments={change.title.segments} side="before" />
                            </p>
                            <p className="rounded-lg border bg-success/[0.03] p-3 font-medium">
                                <Segments segments={change.title.segments} side="after" />
                            </p>
                        </div>
                    ) : (
                        <p className="rounded-lg border p-3 font-medium">
                            <Segments segments={change.title.segments} />
                        </p>
                    )}
                </section>
            )}

            {change.hunks.length > 0 && (
                <section className="grid gap-3">
                    <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Text</h3>
                    {change.hunks.map((h, i) => (
                        <div key={i} className="overflow-hidden rounded-lg border">
                            <div className="border-b bg-muted/50 px-3 py-1 text-xs text-muted-foreground tabular-nums">¶ {h.paragraph}</div>
                            {view === "split" ? (
                                <div className="grid grid-cols-2 divide-x font-serif text-[15px] leading-relaxed">
                                    {(["before", "after"] as const).map((side) => (
                                        <div key={side} className={cn("grid content-start gap-3 p-3", side === "before" ? "bg-destructive/[0.03]" : "bg-success/[0.03]")}>
                                            <Context text={h.before} />
                                            {h.lines.map((l, j) =>
                                                hasSide(l, side) ? (
                                                    <p key={j}>
                                                        <Segments segments={l} side={side} />
                                                    </p>
                                                ) : (
                                                    <p key={j} className="text-xs text-muted-foreground italic">
                                                        {side === "before" ? "(new paragraph)" : "(paragraph removed)"}
                                                    </p>
                                                )
                                            )}
                                            <Context text={h.after} />
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="grid gap-3 p-3 font-serif text-[15px] leading-relaxed">
                                    <Context text={h.before} />
                                    {h.lines.map((l, j) => (
                                        <p key={j} className="border-l-2 border-brand/60 pl-3">
                                            <Segments segments={l} />
                                        </p>
                                    ))}
                                    <Context text={h.after} />
                                </div>
                            )}
                        </div>
                    ))}
                    {change.moreHunks > 0 && <p className="text-sm text-muted-foreground">and {plural(change.moreHunks, "more place")}: open the chapter after applying to see all.</p>}
                </section>
            )}
        </div>
    );
}

/** The assistant's draft against the chapters, full screen: pick chapters, apply them or put them back. */
export function DraftReview(props: { novelId: number; chatId: string; open: boolean; onOpenChange: (open: boolean) => void; onDone: (note: string, applied: boolean) => void }) {
    const { novelId, chatId, open } = props;
    const [data, setData] = useState<{ changes: DraftChange[]; total: number } | null>(null);
    const [picked, setPicked] = useState<Set<number>>(new Set());
    const [active, setActive] = useState<number | null>(null);
    const [view, setView] = useState<View>("inline");
    const [filter, setFilter] = useState<Filter>("all");
    const [pending, start] = useTransition();
    const listRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);

    const load = useCallback(
        () =>
            start(async () => {
                const res = await getDraftChanges(novelId, chatId);
                if (!res.ok) return void toast.error(res.error);
                const d = res.data!;
                setData(d);
                // chapters changed meanwhile are not picked: applying them is refused anyway
                setPicked(new Set(d.changes.filter((c) => !c.conflict).map((c) => c.chapter)));
                setActive((a) => (a !== null && d.changes.some((c) => c.chapter === a) ? a : (d.changes[0]?.chapter ?? null)));
            }),
        [novelId, chatId]
    );
    useEffect(() => {
        if (open) load();
    }, [open, load]);

    const changes = useMemo(() => data?.changes ?? [], [data]);
    const shown = useMemo(
        () => changes.filter((c) => (filter === "picked" ? picked.has(c.chapter) : filter === "conflicts" ? c.conflict : true)),
        [changes, filter, picked]
    );
    const current = changes.find((c) => c.chapter === active) ?? shown[0];
    const totals = useMemo(() => changes.reduce((t, c) => ({ removed: t.removed + c.removed, added: t.added + c.added }), { removed: 0, added: 0 }), [changes]);
    const conflicts = changes.filter((c) => c.conflict).length;
    const pickedList = [...picked].sort((a, b) => a - b);

    const move = useCallback(
        (step: 1 | -1) => {
            if (!shown.length) return;
            const i = shown.findIndex((c) => c.chapter === current?.chapter);
            const next = shown[Math.min(shown.length - 1, Math.max(0, i + step))];
            setActive(next.chapter);
            listRef.current?.querySelector(`[data-chapter="${next.chapter}"]`)?.scrollIntoView({ block: "nearest" });
            bodyRef.current?.scrollTo({ top: 0 });
        },
        [shown, current]
    );
    const toggle = (chapter: number, on?: boolean) =>
        setPicked((s) => {
            const next = new Set(s);
            if (on ?? !next.has(chapter)) next.add(chapter);
            else next.delete(chapter);
            return next;
        });

    function onKey(e: React.KeyboardEvent) {
        const target = e.target as HTMLElement;
        if (target.closest("input, textarea, [contenteditable=true]")) return;
        if (e.key === "j" || e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
        } else if (e.key === "k" || e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
        } else if (e.key === " " && current && !target.closest("button, a, [role=checkbox]")) {
            e.preventDefault();
            toggle(current.chapter);
        }
    }

    const list = (xs: number[]) => (xs.length > 12 ? `${xs.slice(0, 12).join(", ")} and ${xs.length - 12} more` : xs.join(", "));
    function apply() {
        start(async () => {
            const res = await applyDraftChanges(novelId, chatId, pickedList);
            if (!res.ok) return void toast.error(res.error);
            const { applied, skipped } = res.data!;
            toast.success(`${plural(applied.length, "chapter")} saved${skipped.length ? `, ${skipped.length} not applied` : ""}`);
            props.onDone(
                `[I applied chapters ${list(applied) || "none"}.${skipped.length ? ` Not applied: ${skipped.map((s) => `${s.chapter} (${s.reason})`).join(", ")}.` : ""}]`,
                applied.length > 0
            );
            load();
        });
    }
    function discard() {
        start(async () => {
            const res = await discardDraftChanges(novelId, chatId, pickedList);
            if (!res.ok) return void toast.error(res.error);
            toast.success(`${plural(pickedList.length, "chapter")} put back`);
            props.onDone(`[I discarded the changes in chapters ${list(pickedList)}.]`, false);
            load();
        });
    }

    return (
        <DialogPrimitive.Root open={open} onOpenChange={props.onOpenChange}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/30 data-open:animate-in data-open:fade-in-0" />
                <DialogPrimitive.Popup
                    onKeyDown={onKey}
                    className="fixed inset-2 z-50 flex flex-col overflow-hidden rounded-xl bg-background text-sm ring-1 ring-foreground/10 outline-none sm:inset-4 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-[0.98]"
                >
                    {/* header */}
                    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                        <FileDiff className="size-5 text-brand" />
                        <div className="grid">
                            <DialogPrimitive.Title className="font-heading text-base font-semibold">Draft changes</DialogPrimitive.Title>
                            <p className="text-xs text-muted-foreground">
                                {data
                                    ? data.total
                                        ? `${plural(data.total, "chapter")} · −${totals.removed} +${totals.added} words${conflicts ? ` · ${plural(conflicts, "conflict")}` : ""}${data.total > changes.length ? ` · the first ${changes.length} shown` : ""}`
                                        : "The draft has no changes"
                                    : "Loading…"}
                            </p>
                        </div>
                        <div className="ml-auto flex items-center gap-1 rounded-lg border p-0.5">
                            <Button size="xs" variant={view === "inline" ? "secondary" : "ghost"} onClick={() => setView("inline")}>
                                <Rows3 />
                                Inline
                            </Button>
                            <Button size="xs" variant={view === "split" ? "secondary" : "ghost"} onClick={() => setView("split")}>
                                <Columns2 />
                                Side by side
                            </Button>
                        </div>
                        <DialogPrimitive.Close render={<Button size="icon-sm" variant="ghost" aria-label="Close" />}>
                            <X />
                        </DialogPrimitive.Close>
                    </div>

                    <div className="flex min-h-0 flex-1">
                        {/* chapter list */}
                        <div className="flex w-72 shrink-0 flex-col border-r max-md:hidden">
                            <div className="flex items-center gap-1 border-b p-2">
                                {(
                                    [
                                        ["all", `All ${changes.length}`],
                                        ["picked", `Picked ${picked.size}`],
                                        ...(conflicts ? [["conflicts", `Conflicts ${conflicts}`]] : []),
                                    ] as [Filter, string][]
                                ).map(([f, label]) => (
                                    <Button key={f} size="xs" variant={filter === f ? "secondary" : "ghost"} onClick={() => setFilter(f)}>
                                        {label}
                                    </Button>
                                ))}
                                {changes.length > 0 && (
                                    <Checkbox
                                        className="mr-1 ml-auto"
                                        aria-label="Pick all"
                                        checked={picked.size === changes.length}
                                        indeterminate={picked.size > 0 && picked.size < changes.length}
                                        onCheckedChange={(v) => setPicked(v === true ? new Set(changes.map((c) => c.chapter)) : new Set())}
                                    />
                                )}
                            </div>
                            <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1">
                                {shown.map((c) => (
                                    <div
                                        key={c.chapter}
                                        data-chapter={c.chapter}
                                        onClick={() => {
                                            setActive(c.chapter);
                                            bodyRef.current?.scrollTo({ top: 0 });
                                        }}
                                        className={cn(
                                            "flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted",
                                            current?.chapter === c.chapter && "bg-muted ring-1 ring-foreground/10"
                                        )}
                                    >
                                        <Checkbox className="mt-0.5" checked={picked.has(c.chapter)} onCheckedChange={(v) => toggle(c.chapter, v === true)} onClick={(e) => e.stopPropagation()} />
                                        <div className="grid min-w-0 flex-1">
                                            <div className="flex items-center gap-1.5 text-xs">
                                                <span className="font-medium tabular-nums">{c.chapter}</span>
                                                {c.conflict && <AlertTriangle className="size-3 text-destructive" />}
                                                <span className="ml-auto tabular-nums">
                                                    <span className="text-destructive">−{c.removed}</span> <span className="text-success">+{c.added}</span>
                                                </span>
                                            </div>
                                            <span className="truncate text-xs text-muted-foreground">{c.currentTitle}</span>
                                        </div>
                                    </div>
                                ))}
                                {data && !shown.length && <p className="p-3 text-xs text-muted-foreground">Nothing here.</p>}
                            </div>
                        </div>

                        {/* the chapter */}
                        <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
                            {current ? (
                                <ChapterDiff change={current} view={view} novelId={novelId} />
                            ) : (
                                <div className="grid h-full place-items-center text-muted-foreground">{pending ? <Loader2 className="animate-spin" /> : "No changes to review."}</div>
                            )}
                        </div>
                    </div>

                    {/* footer */}
                    <div className="flex flex-wrap items-center gap-2 border-t px-4 py-3">
                        <Button size="icon-sm" variant="outline" aria-label="Previous chapter" disabled={!shown.length} onClick={() => move(-1)}>
                            <ChevronUp />
                        </Button>
                        <Button size="icon-sm" variant="outline" aria-label="Next chapter" disabled={!shown.length} onClick={() => move(1)}>
                            <ChevronDown />
                        </Button>
                        {current && (
                            <label className="flex items-center gap-2 text-xs">
                                <Checkbox checked={picked.has(current.chapter)} onCheckedChange={(v) => toggle(current.chapter, v === true)} />
                                Pick chapter {current.chapter}
                            </label>
                        )}
                        <span className="text-xs text-muted-foreground max-sm:hidden">J/K or ↑/↓ to move, Space to pick</span>
                        <div className="ml-auto flex gap-2">
                            <Button size="sm" variant="outline" disabled={pending || !picked.size} onClick={discard}>
                                <Undo2 />
                                Discard {plural(picked.size, "chapter")}
                            </Button>
                            <Button size="sm" disabled={pending || !picked.size} onClick={apply}>
                                {pending ? <Loader2 className="animate-spin" /> : <Check />}
                                Apply {plural(picked.size, "chapter")}
                            </Button>
                        </div>
                    </div>
                </DialogPrimitive.Popup>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}
