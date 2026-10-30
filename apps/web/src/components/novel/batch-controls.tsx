"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, FileSearch, ListRestart, Loader2, Play, Square, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatNumber } from "@/lib/utils";
import { cancelBatches, startBatchTranslation, startExtraction } from "@/server/actions/batch";
import { useLive } from "./live";
import { StartDialog, type RunCounts } from "./run-controls";

/**
 * Run controls of a batch novel: extract terms (all chapters at once), then translate (all at once).
 * While a batch is open the only action is to cancel it.
 */
export function BatchControls({ novelId, counts, hasKey, extracted, candidates }: { novelId: number; counts: RunCounts; hasKey: boolean; extracted: number; candidates: number }) {
    const live = useLive();
    const [pending, start] = useTransition();
    const [translateOpen, setTranslateOpen] = useState(false);
    const [rangeOpen, setRangeOpen] = useState(false);
    const notExtracted = counts.total - extracted;

    const run = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, after?: () => void) =>
        start(async () => {
            const res = await fn();
            if (!res.ok) return void toast.error(res.error);
            if (res.message) toast.success(res.message);
            after?.();
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

    if (live.status === "running") {
        return (
            <Button variant="outline" disabled={pending} onClick={() => run(() => cancelBatches(novelId))}>
                {pending ? <Loader2 className="animate-spin" /> : <Square />}
                Cancel the batch
            </Button>
        );
    }

    const extractFirst = notExtracted > 0;
    return (
        <>
            <div className="flex">
                {extractFirst ? (
                    <Button className="rounded-r-none" disabled={pending} onClick={() => run(() => startExtraction(novelId, { kind: "missing" }))}>
                        {pending ? <Loader2 className="animate-spin" /> : <FileSearch />}
                        Extract terms · {formatNumber(notExtracted)}
                    </Button>
                ) : (
                    <Button className="rounded-r-none" disabled={pending} onClick={() => setTranslateOpen(true)}>
                        {pending ? <Loader2 className="animate-spin" /> : <Play />}
                        Translate
                    </Button>
                )}
                <DropdownMenu>
                    <DropdownMenuTrigger render={<Button size="icon" className="rounded-l-none border-l border-primary-foreground/15" aria-label="More" />}>
                        <ChevronDown />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-64">
                        {extractFirst ? (
                            <DropdownMenuItem onClick={() => setTranslateOpen(true)}>
                                <Play />
                                Translate…
                            </DropdownMenuItem>
                        ) : (
                            <DropdownMenuItem disabled>
                                <FileSearch />
                                Terms are extracted from every chapter
                            </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => setRangeOpen(true)}>
                            <FileSearch />
                            Extract terms again from…
                        </DropdownMenuItem>
                        {counts.failed > 0 && (
                            <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => run(() => startBatchTranslation(novelId, { kind: "failed" }))}>
                                    <ListRestart />
                                    Retry {counts.failed} failed
                                </DropdownMenuItem>
                            </>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            <StartDialog
                novelId={novelId}
                open={translateOpen}
                onOpenChange={setTranslateOpen}
                counts={counts}
                pending={pending}
                description="All chapters go out as one batch at half the price; the results usually come back within an hour. The glossary is used as it is now."
                note={
                    (candidates > 0 || notExtracted > 0) && (
                        <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2.5 text-sm">
                            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]" />
                            <div>
                                {candidates > 0 && (
                                    <div>
                                        {formatNumber(candidates)} {candidates === 1 ? "term waits" : "terms wait"} in{" "}
                                        <Link href={`/novels/${novelId}/candidates`} className="text-brand hover:underline" onClick={() => setTranslateOpen(false)}>
                                            Candidates
                                        </Link>
                                        : chapters that use them are translated without a glossary entry.
                                    </div>
                                )}
                                {notExtracted > 0 && <div>Terms of {formatNumber(notExtracted)} chapters are not extracted yet.</div>}
                            </div>
                        </div>
                    )
                }
                onStart={(scope) => run(() => startBatchTranslation(novelId, scope), () => setTranslateOpen(false))}
            />
            <ExtractRangeDialog
                open={rangeOpen}
                onOpenChange={setRangeOpen}
                counts={counts}
                pending={pending}
                onStart={(from, to) => run(() => startExtraction(novelId, { kind: "range", from, to }), () => setRangeOpen(false))}
            />
        </>
    );
}

function ExtractRangeDialog({
    open,
    onOpenChange,
    counts,
    pending,
    onStart,
}: {
    open: boolean;
    onOpenChange: (v: boolean) => void;
    counts: RunCounts;
    pending: boolean;
    onStart: (from: number, to: number) => void;
}) {
    const [from, setFrom] = useState(String(counts.minIndex || 1));
    const [to, setTo] = useState(String(counts.maxIndex || 1));
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Extract terms again</DialogTitle>
                    <DialogDescription>
                        The chapters are read again with the glossary as it is now. What they gave before is replaced; terms already in the glossary stay.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex items-end gap-3">
                    <div className="grid flex-1 gap-1.5">
                        <Label htmlFor="extract-from">From</Label>
                        <Input id="extract-from" type="number" value={from} onChange={(e) => setFrom(e.target.value)} />
                    </div>
                    <div className="grid flex-1 gap-1.5">
                        <Label htmlFor="extract-to">To</Label>
                        <Input id="extract-to" type="number" value={to} onChange={(e) => setTo(e.target.value)} />
                    </div>
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button disabled={pending} onClick={() => onStart(Number(from), Number(to))}>
                        {pending ? <Loader2 className="animate-spin" /> : <FileSearch />}
                        Extract
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
