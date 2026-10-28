"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, CheckCheck, Hourglass, Inbox, Loader2, Lock, Pencil, Quote, Undo2 } from "lucide-react";
import { EmptyState } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { affectedChapters, decideChange, retranslate } from "@/server/actions/glossary";
import type { DecisionGroup } from "@/server/decision-groups";

const GENDER: Record<string, string> = { m: "male", f: "female", unknown: "unknown" };
const show = (field: string, v: string) => (field === "gender" ? (GENDER[v] ?? v) : v);

export function DecisionList({ groups, showNovel, waiting }: { groups: DecisionGroup[]; showNovel?: boolean; waiting?: boolean }) {
    const router = useRouter();
    const [done, setDone] = useState<Set<string>>(new Set());
    const [bulk, startBulk] = useTransition();
    const visible = groups.filter((g) => !done.has(g.key));

    const markDone = (key: string) => setDone((s) => new Set(s).add(key));

    if (!visible.length) {
        return <EmptyState icon={Inbox} title="Nothing to decide" description="When the model proposes changing a term that is already in the glossary, it shows up here (and in Telegram, if you linked it)." />;
    }

    return (
        <div className="grid gap-4">
            {waiting && (
                <div className="flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/8 p-3.5 text-sm">
                    <Hourglass className="size-4 shrink-0 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]" />
                    The translation waits for these decisions. It continues on its own once the chapter&apos;s proposals are decided.
                </div>
            )}
            <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                    {visible.length} {visible.length === 1 ? "term" : "terms"} to decide
                </span>
                <Button
                    variant="ghost"
                    size="sm"
                    disabled={bulk}
                    onClick={() =>
                        startBulk(async () => {
                            for (const g of visible) {
                                const res = await decideChange({ novelId: g.novelId, termId: g.term.id, field: g.field, useChangeId: null });
                                if (res.ok) markDone(g.key);
                            }
                            toast.success("Kept the current glossary for all");
                            router.refresh();
                        })
                    }
                >
                    {bulk ? <Loader2 className="animate-spin" /> : <Undo2 />}
                    Keep current for all
                </Button>
            </div>
            {visible.map((g) => (
                <DecisionCard key={g.key} group={g} showNovel={showNovel} onDone={() => markDone(g.key)} />
            ))}
        </div>
    );
}

function DecisionCard({ group: g, showNovel, onDone }: { group: DecisionGroup; showNovel?: boolean; onDone: () => void }) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const [custom, setCustom] = useState<string | null>(null);
    const [lock, setLock] = useState(false);
    const values = [...new Map(g.changes.map((c) => [c.newValue, c])).values()];

    const decide = (useChangeId: number | null, customValue?: string) =>
        start(async () => {
            const res = await decideChange({ novelId: g.novelId, termId: g.term.id, field: g.field, useChangeId, custom: customValue ?? null, lock });
            if (!res.ok) return void toast.error(res.error);
            onDone();
            const applied = res.data?.applied;
            if (res.data?.resumed) toast.success("All decided, the translation continues");
            if (applied !== null && applied !== undefined && g.field === "target") {
                const affected = await affectedChapters(g.novelId, [g.term.id]);
                const list = affected.ok ? (affected.data ?? []) : [];
                if (list.length) {
                    toast(`${g.term.source} → ${applied}`, {
                        description: `${list.length} translated chapters still use “${g.current}”.`,
                        duration: 12000,
                        action: {
                            label: "Translate again",
                            onClick: async () => {
                                const r = await retranslate(g.novelId, list);
                                if (r.ok) toast.success(r.message ?? "Queued");
                                else toast.error(r.error);
                                router.refresh();
                            },
                        },
                    });
                } else toast.success(`${g.term.source} → ${applied}`);
            } else if (!res.data?.resumed) toast.success(applied === null ? "Kept" : "Applied");
            router.refresh();
        });

    return (
        <div className={cn("rounded-xl border bg-card shadow-xs transition-opacity", pending && "opacity-60")}>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
                <div className="min-w-0">
                    {showNovel && (
                        <Link href={`/novels/${g.novelId}/decisions`} className="mb-1 block text-xs text-muted-foreground hover:text-foreground">
                            {g.novelTitle}
                        </Link>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-lg font-semibold tracking-tight">{g.term.source}</span>
                        <Badge variant="muted">{g.term.type}</Badge>
                        {g.term.locked && (
                            <Badge variant="outline">
                                <Lock />
                                locked
                            </Badge>
                        )}
                    </div>
                    {g.term.note && <p className="mt-0.5 text-sm text-muted-foreground">{g.term.note}</p>}
                </div>
                <div className="text-right">
                    <div className="text-xs text-muted-foreground">{g.field === "target" ? "Translation now" : "Gender now"}</div>
                    <div className="font-medium">{show(g.field, g.current)}</div>
                </div>
            </div>
            <div className="grid gap-2 px-5 py-4">
                <div className="text-xs font-medium text-muted-foreground">{values.length === 1 ? "The model proposes" : `${values.length} proposals`}</div>
                {values.map((c) => {
                    const all = g.changes.filter((x) => x.newValue === c.newValue);
                    return (
                        <div key={c.id} className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3 sm:flex-row sm:items-center">
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-baseline gap-2">
                                    <span className="text-base font-medium text-brand">{show(g.field, c.newValue)}</span>
                                    <span className="text-xs text-muted-foreground">
                                        {all.length > 1 ? `${all.length}×, ` : ""}chapter {all.map((x) => x.chapter ?? "?").join(", ")}
                                    </span>
                                </div>
                                {c.reason && <p className="mt-1 text-sm text-muted-foreground">{c.reason}</p>}
                                {c.evidence && (
                                    <p className="mt-1.5 flex gap-1.5 font-serif text-sm text-muted-foreground italic">
                                        <Quote className="mt-0.5 size-3.5 shrink-0" />
                                        {c.evidence}
                                    </p>
                                )}
                            </div>
                            <Button size="sm" disabled={pending} onClick={() => decide(c.id)} className="shrink-0">
                                <Check />
                                Use this
                            </Button>
                        </div>
                    );
                })}
                {custom !== null && (
                    <form
                        className="flex gap-2"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (custom.trim()) decide(null, custom);
                        }}
                    >
                        <Input autoFocus value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Your translation" />
                        <Button type="submit" size="default" disabled={pending || !custom.trim()}>
                            <CheckCheck />
                            Save
                        </Button>
                    </form>
                )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t bg-muted/20 px-5 py-3">
                <Button variant="outline" size="sm" disabled={pending} onClick={() => decide(null)}>
                    {pending ? <Loader2 className="animate-spin" /> : <Undo2 />}
                    Keep “{show(g.field, g.current)}”
                </Button>
                {g.field === "target" && custom === null && (
                    <Button variant="ghost" size="sm" onClick={() => setCustom(g.current)}>
                        <Pencil />
                        Type my own
                    </Button>
                )}
                <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox checked={lock} onCheckedChange={(v) => setLock(v === true)} />
                    Lock the term after deciding
                </label>
            </div>
        </div>
    );
}
