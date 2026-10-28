"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, Inbox, ListRestart, Loader2, Pause, Play, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn, formatNumber } from "@/lib/utils";
import { clearQueue, pauseRun, resumeRun, startRun, stopNow, type RunScope } from "@/server/actions/run";
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

function StartDialog({ open, onOpenChange, counts, pending, onStart }: { open: boolean; onOpenChange: (v: boolean) => void; counts: RunCounts; pending: boolean; onStart: (scope: RunScope) => void }) {
    const [kind, setKind] = useState<ScopeKind>(counts.untranslated ? "untranslated" : counts.failed ? "failed" : "range");
    const [from, setFrom] = useState(String(counts.minIndex || 1));
    const [to, setTo] = useState(String(counts.maxIndex || 1));
    const [retranslate, setRetranslate] = useState(false);

    const options: { kind: ScopeKind; title: string; text: string; disabled?: boolean }[] = [
        { kind: "untranslated", title: "Everything not translated yet", text: `${formatNumber(counts.untranslated)} chapters, in order`, disabled: !counts.untranslated },
        { kind: "failed", title: "Failed chapters", text: `${formatNumber(counts.failed)} chapters`, disabled: !counts.failed },
        { kind: "range", title: "A range of chapters", text: "From one chapter number to another" },
    ];

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Translate chapters</DialogTitle>
                    <DialogDescription>Chapters are translated strictly in order, so terms found in one chapter are known in the next.</DialogDescription>
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
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        disabled={pending}
                        onClick={() =>
                            onStart(kind === "range" ? { kind: "range", from: Number(from), to: Number(to), retranslate } : { kind })
                        }
                    >
                        {pending ? <Loader2 className="animate-spin" /> : <Play />}
                        Start
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
