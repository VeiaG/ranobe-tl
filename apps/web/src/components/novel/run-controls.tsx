"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, Coins, Inbox, ListRestart, Loader2, Pause, Play, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, formatNumber } from "@/lib/utils";
import { clearQueue, estimate, pauseRun, resumeRun, startRun, stopNow, type RunScope } from "@/server/actions/run";
import { useLive } from "./live";

export interface RunCounts {
    total: number;
    done: number;
    failed: number;
    queued: number;
    untranslated: number;
    minIndex: number;
    maxIndex: number;
}

type ScopeKind = "untranslated" | "failed" | "range";

export function RunControls({ novelId, counts, hasKey }: { novelId: number; counts: RunCounts; hasKey: boolean }) {
    const live = useLive();
    const [pending, start] = useTransition();
    const [open, setOpen] = useState(false);
    const status = live.status;

    const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>) =>
        start(async () => {
            const res = await fn();
            if (!res.ok) toast.error(res.error);
            else if (res.message) toast.success(res.message);
            live.kick();
        });

    if (!hasKey) {
        return (
            <Button variant="outline" nativeButton={false} render={<Link href={`/novels/${novelId}/settings`} />}>Choose an API key</Button>
        );
    }

    if (counts.total === 0) {
        return (
            <Button nativeButton={false} render={<Link href={`/novels/${novelId}/chapters?upload=1`} />}>Upload chapters</Button>
        );
    }

    return (
        <>
            {status === "running" ? (
                <div className="flex">
                    <Button variant="outline" className="rounded-r-none" disabled={pending} onClick={() => run(() => pauseRun(novelId))}>
                        {pending ? <Loader2 className="animate-spin" /> : <Pause />}
                        Pause
                    </Button>
                    <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="outline" size="icon" className="rounded-l-none border-l-0" aria-label="More" />}>
                                <ChevronDown />
                            </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-64">
                            <DropdownMenuItem onClick={() => run(() => pauseRun(novelId))}>
                                <Pause />
                                <div>
                                    <div>Pause after this chapter</div>
                                    <div className="text-xs text-muted-foreground">Nothing is lost</div>
                                </div>
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onClick={() => run(() => stopNow(novelId))}>
                                <Square />
                                <div>
                                    <div>Stop now</div>
                                    <div className="text-xs opacity-80">The chapter in flight is dropped</div>
                                </div>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            ) : status === "waiting" ? (
                <>
                    <Button variant="outline" disabled={pending} onClick={() => run(() => resumeRun(novelId))}>
                        <Play />
                        Resume anyway
                    </Button>
                    <Button nativeButton={false} render={<Link href={`/novels/${novelId}/decisions`} />}>
                            <Inbox />
                            Decide
                        </Button>
                </>
            ) : (
                <div className="flex">
                    {counts.queued > 0 ? (
                        <Button className="rounded-r-none" disabled={pending} onClick={() => run(() => resumeRun(novelId))}>
                            {pending ? <Loader2 className="animate-spin" /> : <Play />}
                            Resume · {formatNumber(counts.queued)} queued
                        </Button>
                    ) : (
                        <Button className="rounded-r-none" disabled={pending} onClick={() => setOpen(true)}>
                            {pending ? <Loader2 className="animate-spin" /> : <Play />}
                            Translate
                        </Button>
                    )}
                    <DropdownMenu>
                        <DropdownMenuTrigger render={<Button size="icon" className="rounded-l-none border-l border-primary-foreground/15" aria-label="More" />}>
                                <ChevronDown />
                            </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuItem onClick={() => setOpen(true)}>
                                <Play />
                                Choose chapters…
                            </DropdownMenuItem>
                            {counts.failed > 0 && (
                                <DropdownMenuItem onClick={() => run(() => startRun(novelId, { kind: "failed" }))}>
                                    <ListRestart />
                                    Retry {counts.failed} failed
                                </DropdownMenuItem>
                            )}
                            {counts.queued > 0 && (
                                <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={() => run(() => clearQueue(novelId))}>
                                        <X />
                                        Clear the queue
                                    </DropdownMenuItem>
                                </>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            )}
            <StartDialog
                novelId={novelId}
                open={open}
                onOpenChange={setOpen}
                counts={counts}
                pending={pending}
                onStart={(scope) =>
                    run(async () => {
                        const res = await startRun(novelId, scope);
                        if (res.ok) setOpen(false);
                        return res;
                    })
                }
            />
        </>
    );
}

interface EstimateView {
    chapters: number;
    usd: number | null;
    model: string;
    basis: "history" | "guess";
    spentUsd: number;
    budgetUsd: number | null;
}

function usd(n: number) {
    return n >= 100 ? `$${n.toFixed(0)}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`;
}

export function StartDialog({
    novelId,
    open,
    onOpenChange,
    counts,
    pending,
    onStart,
    description = "Chapters are translated strictly in order, so terms found in one chapter are known in the next.",
    note,
}: {
    novelId: number;
    open: boolean;
    onOpenChange: (v: boolean) => void;
    counts: RunCounts;
    pending: boolean;
    onStart: (scope: RunScope) => void;
    description?: string;
    /** Shown above the estimate, e.g. a warning. */
    note?: React.ReactNode;
}) {
    const [kind, setKind] = useState<ScopeKind>(counts.untranslated ? "untranslated" : counts.failed ? "failed" : "range");
    const [from, setFrom] = useState(String(counts.minIndex || 1));
    const [to, setTo] = useState(String(counts.maxIndex || 1));
    const [retranslate, setRetranslate] = useState(false);

    const [est, setEst] = useState<EstimateView | null>(null);
    const scope: RunScope = kind === "range" ? { kind: "range", from: Number(from), to: Number(to), retranslate } : { kind };
    const scopeKey = JSON.stringify(scope);
    useEffect(() => {
        if (!open) return;
        let alive = true;
        const t = setTimeout(async () => {
            const res = await estimate(novelId, JSON.parse(scopeKey));
            if (alive && res.ok && res.data) setEst(res.data);
        }, 250);
        return () => {
            alive = false;
            clearTimeout(t);
        };
    }, [open, novelId, scopeKey]);

    const options: { kind: ScopeKind; title: string; text: string; disabled?: boolean }[] = [
        { kind: "untranslated", title: "Everything not translated yet", text: `${formatNumber(counts.untranslated)} chapters`, disabled: !counts.untranslated },
        { kind: "failed", title: "Failed chapters", text: `${formatNumber(counts.failed)} chapters`, disabled: !counts.failed },
        { kind: "range", title: "A range of chapters", text: "From one chapter number to another" },
    ];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Translate chapters</DialogTitle>
                    <DialogDescription>{description}</DialogDescription>
                </DialogHeader>
                <div className="grid gap-2">
                    {options.map((o) => (
                        <button
                            key={o.kind}
                            type="button"
                            disabled={o.disabled}
                            onClick={() => setKind(o.kind)}
                            className={cn(
                                "flex items-center gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-45",
                                kind === o.kind && "border-brand/60 bg-brand/5 ring-1 ring-brand/30"
                            )}
                        >
                            <span className={cn("flex size-4 items-center justify-center rounded-full border", kind === o.kind && "border-brand")}>
                                {kind === o.kind && <span className="size-2 rounded-full bg-brand" />}
                            </span>
                            <span>
                                <span className="block text-sm font-medium">{o.title}</span>
                                <span className="block text-xs text-muted-foreground">{o.text}</span>
                            </span>
                        </button>
                    ))}
                </div>
                {kind === "range" && (
                    <div className="grid gap-3 rounded-lg bg-muted/50 p-3">
                        <div className="flex items-end gap-3">
                            <div className="grid flex-1 gap-1.5">
                                <Label htmlFor="from">From</Label>
                                <Input id="from" type="number" value={from} onChange={(e) => setFrom(e.target.value)} />
                            </div>
                            <div className="grid flex-1 gap-1.5">
                                <Label htmlFor="to">To</Label>
                                <Input id="to" type="number" value={to} onChange={(e) => setTo(e.target.value)} />
                            </div>
                        </div>
                        <label className="flex items-center gap-2 text-sm">
                            <Checkbox checked={retranslate} onCheckedChange={(v) => setRetranslate(v === true)} />
                            Translate again chapters that are already done
                        </label>
                    </div>
                )}
                {note}
                {est && (
                    <div className="flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm">
                        <Coins className="mt-0.5 size-4 shrink-0 text-brand" />
                        <div className="min-w-0">
                            <div>
                                {est.chapters === 0 ? (
                                    "No chapters in this selection"
                                ) : est.usd === null ? (
                                    <>
                                        {formatNumber(est.chapters)} chapters · no price for <code className="font-mono text-xs">{est.model || "this model"}</code> (set it in Usage → Prices)
                                    </>
                                ) : (
                                    <>
                                        {formatNumber(est.chapters)} chapters · about <span className="font-medium">{usd(est.usd)}</span>
                                    </>
                                )}
                            </div>
                            <div className="text-xs text-muted-foreground">
                                {est.basis === "history" ? "from what this novel's chapters cost so far" : "a rough guess from the text length; it gets precise after a few chapters"}
                            </div>
                            {est.budgetUsd !== null && (
                                <div className={cn("mt-1 text-xs", est.spentUsd + (est.usd ?? 0) > est.budgetUsd ? "text-destructive" : "text-muted-foreground")}>
                                    Budget: {usd(est.spentUsd)} spent of {usd(est.budgetUsd)}
                                    {est.spentUsd + (est.usd ?? 0) > est.budgetUsd && ": the run pauses when the budget is reached"}
                                </div>
                            )}
                        </div>
                    </div>
                )}
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button disabled={pending} onClick={() => onStart(scope)}>
                        {pending ? <Loader2 className="animate-spin" /> : <Play />}
                        Start
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
