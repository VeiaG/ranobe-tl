"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, CheckCheck, Hourglass, Inbox, Loader2, Lock, Pencil, Quote, Sparkles, Trash2, Undo2 } from "lucide-react";
import { TERM_TYPES, type Gender, type TermType } from "@ranobe-tl/core";
import { EmptyState } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
    const newTerms = visible.filter((g) => g.field === "new");
    const changes = visible.filter((g) => g.field !== "new");

    /** New terms are confirmed as proposed, changes keep the current value: nothing in the glossary changes. */
    const decideAll = (list: DecisionGroup[], message: string) =>
        startBulk(async () => {
            let resumed = false;
            for (const g of list) {
                const res = await decideChange({ novelId: g.novelId, termId: g.term.id, field: g.field, useChangeId: null });
                if (!res.ok) {
                    toast.error(`${g.term.source}: ${res.error}`);
                    continue;
                }
                markDone(g.key);
                resumed ||= !!res.data?.resumed;
            }
            toast.success(resumed ? `${message}, the translation continues` : message);
            router.refresh();
        });

    if (!visible.length) {
        return <EmptyState icon={Inbox} title="Nothing to decide" description="When the model proposes changing a term that is already in the glossary (or finds a new one, if new terms are reviewed for this novel), it shows up here and in Telegram, if you linked it." />;
    }

    return (
        <div className="grid gap-4">
            {waiting && (
                <div className="flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/8 p-3.5 text-sm">
                    <Hourglass className="size-4 shrink-0 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]" />
                    The translation waits for these decisions. It continues on its own once the chapter&apos;s proposals are decided.
                </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
                <span>
                    {visible.length} {visible.length === 1 ? "term" : "terms"} to decide
                </span>
                <div className="flex flex-wrap gap-1">
                    {newTerms.length > 0 && (
                        <Button variant="ghost" size="sm" disabled={bulk} onClick={() => decideAll(newTerms, `${newTerms.length} new ${newTerms.length === 1 ? "term" : "terms"} confirmed`)}>
                            {bulk ? <Loader2 className="animate-spin" /> : <CheckCheck />}
                            Confirm all new terms{changes.length ? ` (${newTerms.length})` : ""}
                        </Button>
                    )}
                    {changes.length > 0 && (
                        <Button variant="ghost" size="sm" disabled={bulk} onClick={() => decideAll(changes, "The glossary stays as it is")}>
                            {bulk ? <Loader2 className="animate-spin" /> : <Undo2 />}
                            Keep current values{newTerms.length ? ` (${changes.length})` : ""}
                        </Button>
                    )}
                </div>
            </div>
            {visible.map((g) =>
                g.field === "new" ? (
                    <NewTermCard key={g.key} group={g} showNovel={showNovel} onDone={() => markDone(g.key)} />
                ) : (
                    <DecisionCard key={g.key} group={g} showNovel={showNovel} onDone={() => markDone(g.key)} />
                )
            )}
        </div>
    );
}

/** The Replace tab's assistant with a task to bring old translations of a term in line with its new one. */
export function assistantLink(novelId: number, source: string, old: string, next: string, chapters: number[]) {
    const where = chapters.length > 80 ? `${chapters.length} chapters` : `chapters ${chapters.join(", ")}`;
    const task = `The term “${source}” is now translated as “${next}”; it used to be “${old}”. Find the old translation and any other variants of it, in every grammatical form, in the translated chapters, and propose edits to the new translation in the right form. The source mentions it in ${where}.`;
    return `/novels/${novelId}/replace?mode=assistant&task=${encodeURIComponent(task)}`;
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
                        cancel: { label: "Fix with the assistant", onClick: () => router.push(assistantLink(g.novelId, g.term.source, g.current, applied, list)) },
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

/** Review of a new term: it is already in the glossary, so confirming keeps it, edits fix it, "not a term" removes it for good. */
function NewTermCard({ group: g, showNovel, onDone }: { group: DecisionGroup; showNovel?: boolean; onDone: () => void }) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const [target, setTarget] = useState(g.term.target);
    const [type, setType] = useState(g.term.type);
    const [gender, setGender] = useState(g.term.gender ?? "unknown");
    const [lock, setLock] = useState(false);
    const c = g.changes[0];
    const edited = target.trim() !== g.term.target || type !== g.term.type || (type === "person" && gender !== (g.term.gender ?? "unknown"));

    const decide = (remove: boolean) =>
        start(async () => {
            const res = await decideChange({
                novelId: g.novelId,
                termId: g.term.id,
                field: "new",
                remove,
                custom: target.trim() !== g.term.target ? target : null,
                type: type as TermType,
                gender: type === "person" ? (gender as Gender) : undefined,
                lock,
            });
            if (!res.ok) return void toast.error(res.error);
            onDone();
            if (res.data?.resumed) toast.success("All decided, the translation continues");
            else toast.success(remove ? `${g.term.source}: removed, it will not be proposed again` : `${g.term.source} → ${res.data?.applied}`);
            if (!remove && target.trim() !== g.term.target) {
                const affected = await affectedChapters(g.novelId, [g.term.id]);
                const list = affected.ok ? (affected.data ?? []) : [];
                if (list.length) {
                    toast(`${list.length} translated chapters use the old “${g.term.target}”`, {
                        duration: 12000,
                        cancel: { label: "Fix with the assistant", onClick: () => router.push(assistantLink(g.novelId, g.term.source, g.term.target, target.trim(), list)) },
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
                }
            }
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
                        <Badge variant="brand">
                            <Sparkles />
                            new term
                        </Badge>
                    </div>
                    {c.reason && <p className="mt-0.5 text-sm text-muted-foreground">{c.reason}</p>}
                </div>
                <div className="text-right text-xs text-muted-foreground">first seen in chapter {c.chapter ?? g.term.firstChapter ?? "?"}</div>
            </div>
            <div className="grid gap-3 px-5 py-4 sm:grid-cols-[1fr_9rem_8rem]">
                <div className="grid gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Translation</span>
                    <Input value={target} onChange={(e) => setTarget(e.target.value)} className="text-base" />
                </div>
                <div className="grid gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">Type</span>
                    <Select value={type} onValueChange={(v) => v && setType(v)}>
                        <SelectTrigger className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {TERM_TYPES.map((t) => (
                                <SelectItem key={t} value={t}>
                                    {t}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                {type === "person" && (
                    <div className="grid gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Gender</span>
                        <Select value={gender} onValueChange={(v) => v && setGender(v)}>
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="m">male</SelectItem>
                                <SelectItem value="f">female</SelectItem>
                                <SelectItem value="unknown">unknown</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                )}
                {c.evidence && (
                    <p className="flex gap-1.5 font-serif text-sm text-muted-foreground italic sm:col-span-3">
                        <Quote className="mt-0.5 size-3.5 shrink-0" />
                        {c.evidence}
                    </p>
                )}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t bg-muted/20 px-5 py-3">
                <Button size="sm" disabled={pending || !target.trim()} onClick={() => decide(false)}>
                    {pending ? <Loader2 className="animate-spin" /> : <Check />}
                    {edited ? "Save and confirm" : "Looks right"}
                </Button>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={pending} onClick={() => decide(true)}>
                    <Trash2 />
                    Not a term
                </Button>
                <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox checked={lock} onCheckedChange={(v) => setLock(v === true)} />
                    Lock it
                </label>
            </div>
        </div>
    );
}
