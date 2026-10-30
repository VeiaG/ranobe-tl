"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Ban, Check, CheckCheck, ChevronDown, Inbox, Loader2, Lock, Quote, Search, Sparkles, Undo2 } from "lucide-react";
import { TERM_TYPES, type TermType } from "@ranobe-tl/core";
import { assistantLink } from "@/components/decisions";
import { EmptyState } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn, formatNumber } from "@/lib/utils";
import { acceptCandidate, acceptCandidates, adviseCandidate, candidateSnippets, dismissCandidate } from "@/server/actions/batch";
import { affectedChapters, retranslate } from "@/server/actions/glossary";
import type { CandidateGroup, Snippet } from "@/server/batch/merge";

type GenderChoice = "m" | "f" | "unknown" | "timeline";

/** How many "Ask the model" requests run at once. */
const ADVICE_PARALLEL = 3;

/** The entry a group would get with one click: the model's advice, else the glossary's or the most common translation. */
function defaultChoice(g: CandidateGroup) {
    const a = g.advice;
    if (a) return { target: a.target, type: a.type as TermType, note: a.note, gender: (a.gender || "unknown") as GenderChoice };
    const gender: GenderChoice = g.genders.length > 1 ? "timeline" : (g.genders[0]?.gender ?? "unknown");
    return { target: g.existing?.target ?? g.variants[0]?.target ?? "", type: g.type, note: g.notes[0] ?? "", gender };
}

export function CandidatesPanel({ novelId, groups }: { novelId: number; groups: CandidateGroup[] }) {
    const router = useRouter();
    const [query, setQuery] = useState("");
    const [done, setDone] = useState<Set<string>>(new Set());
    const [bulk, startBulk] = useTransition();
    const [progress, setProgress] = useState<string>();

    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return groups.filter((g) => !done.has(g.key) && (!q || g.source.toLowerCase().includes(q) || g.variants.some((v) => v.target.toLowerCase().includes(q))));
    }, [groups, done, query]);
    const withoutAdvice = visible.filter((g) => !g.advice);
    const withAdvice = visible.filter((g) => g.advice);
    const markDone = (key: string) => setDone((s) => new Set(s).add(key));

    const askAll = () =>
        startBulk(async () => {
            const queue = [...withoutAdvice];
            let n = 0;
            let failed = 0;
            const worker = async () => {
                for (let g = queue.shift(); g; g = queue.shift()) {
                    const res = await adviseCandidate(novelId, g.key);
                    if (!res.ok) failed++;
                    setProgress(`${++n} of ${withoutAdvice.length}`);
                }
            };
            await Promise.all(Array.from({ length: ADVICE_PARALLEL }, worker));
            setProgress(undefined);
            if (failed) toast.error(`${failed} requests failed`);
            else toast.success("The model answered for every term");
            router.refresh();
        });

    const mergeAdvised = () =>
        startBulk(async () => {
            const res = await acceptCandidates(
                novelId,
                withAdvice.map((g) => ({ key: g.key, choice: defaultChoice(g) }))
            );
            if (!res.ok) return void toast.error(res.error);
            withAdvice.forEach((g) => markDone(g.key));
            toast.success(res.message ?? "Merged");
            router.refresh();
        });

    if (!groups.length) {
        return (
            <EmptyState
                icon={Inbox}
                title="Nothing to merge"
                description="Terms extracted from the chapters land here only when the chapters disagree (several translations, a gender that changes) or differ from the glossary. Everything else goes into the glossary on its own."
            />
        );
    }

    return (
        <div className="grid gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="relative w-full max-w-xs">
                    <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a term" className="pl-8" />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                    <span className="mr-2 text-sm text-muted-foreground">
                        {formatNumber(visible.length)} {visible.length === 1 ? "term" : "terms"}
                        {progress && ` · asking ${progress}`}
                    </span>
                    {withoutAdvice.length > 0 && (
                        <Button variant="ghost" size="sm" disabled={bulk} onClick={askAll}>
                            {bulk ? <Loader2 className="animate-spin" /> : <Sparkles />}
                            Ask the model about {withAdvice.length ? `the other ${withoutAdvice.length}` : `all ${withoutAdvice.length}`}
                        </Button>
                    )}
                    {withAdvice.length > 0 && (
                        <Button variant="ghost" size="sm" disabled={bulk} onClick={mergeAdvised}>
                            {bulk ? <Loader2 className="animate-spin" /> : <CheckCheck />}
                            Merge {withAdvice.length} as the model advises
                        </Button>
                    )}
                </div>
            </div>
            {visible.map((g) => (
                <CandidateCard key={`${g.key}:${g.advice ? "advised" : ""}`} novelId={novelId} group={g} onDone={() => markDone(g.key)} />
            ))}
        </div>
    );
}

function CandidateCard({ novelId, group: g, onDone }: { novelId: number; group: CandidateGroup; onDone: () => void }) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const [asking, startAsking] = useTransition();
    const initial = defaultChoice(g);
    const [target, setTarget] = useState(initial.target);
    const [type, setType] = useState<TermType>(initial.type);
    const [gender, setGender] = useState<GenderChoice>(initial.gender);
    const [note, setNote] = useState(initial.note);
    const [snippets, setSnippets] = useState<Snippet[] | null>(null);
    const [open, setOpen] = useState(false);

    const showContext = () => {
        setOpen((o) => !o);
        if (snippets) return;
        candidateSnippets(novelId, g.key).then((res) => (res.ok ? setSnippets(res.data ?? []) : toast.error(res.error)));
    };

    const ask = () =>
        startAsking(async () => {
            const res = await adviseCandidate(novelId, g.key);
            if (!res.ok) return void toast.error(res.error);
            const a = res.data!;
            setTarget(a.target);
            setType(a.type as TermType);
            setGender((a.gender || "unknown") as GenderChoice);
            setNote(a.note);
            router.refresh();
        });

    const merge = () =>
        start(async () => {
            const res = await acceptCandidate(novelId, g.key, { target, type, note, gender });
            if (!res.ok) return void toast.error(res.error);
            onDone();
            const old = g.existing?.target;
            if (res.data?.changed && old) {
                const affected = await affectedChapters(novelId, [res.data.termId]);
                const list = affected.ok ? (affected.data ?? []) : [];
                if (list.length) {
                    toast(`${g.source} → ${target.trim()}`, {
                        description: `${list.length} translated chapters still use “${old}”.`,
                        duration: 12000,
                        cancel: { label: "Fix with the assistant", onClick: () => router.push(assistantLink(novelId, g.source, old, target.trim(), list)) },
                        action: {
                            label: "Translate again",
                            onClick: async () => {
                                const r = await retranslate(novelId, list);
                                if (r.ok) toast.success(r.message ?? "Sent");
                                else toast.error(r.error);
                                router.refresh();
                            },
                        },
                    });
                    return router.refresh();
                }
            }
            toast.success(`${g.source} → ${target.trim()}`);
            router.refresh();
        });

    const dismiss = (notATerm: boolean) =>
        start(async () => {
            const res = await dismissCandidate(novelId, g.key, notATerm);
            if (!res.ok) return void toast.error(res.error);
            onDone();
            toast.success(notATerm ? `${g.source}: not a term, it will not be proposed again` : `${g.source}: the glossary stays as it is`);
            router.refresh();
        });

    const genderItems: Record<GenderChoice, string> = { m: "male", f: "female", unknown: "unknown", timeline: `as found: ${g.timeline}` };

    return (
        <div className={cn("rounded-xl border bg-card shadow-xs transition-opacity", pending && "opacity-60")}>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="text-lg font-semibold tracking-tight">{g.source}</span>
                        {Object.entries(g.types).map(([t, n]) => (
                            <Badge key={t} variant="muted">
                                {t}
                                {Object.keys(g.types).length > 1 && ` ${n}×`}
                            </Badge>
                        ))}
                        {g.existing?.locked && (
                            <Badge variant="outline">
                                <Lock />
                                locked
                            </Badge>
                        )}
                    </div>
                    {g.reasons.map((r) => (
                        <p key={r} className="mt-0.5 text-sm text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]">
                            {r}
                        </p>
                    ))}
                    {g.notes.length > 0 && <p className="mt-0.5 text-sm text-muted-foreground">{g.notes.join(" · ")}</p>}
                </div>
                <div className="text-right text-xs text-muted-foreground">
                    {g.existing ? (
                        <>
                            <div>In the glossary</div>
                            <div className="text-sm font-medium text-foreground">
                                {g.existing.target}
                                {g.existing.gender && <span className="ml-1 text-muted-foreground">· {g.existing.gender}</span>}
                            </div>
                        </>
                    ) : (
                        <div>new term</div>
                    )}
                    <div className="mt-0.5">
                        in {g.chapters} {g.chapters === 1 ? "chapter" : "chapters"} from #{g.firstChapter}
                    </div>
                </div>
            </div>

            <div className="grid gap-4 px-5 py-4">
                <div className="flex flex-wrap gap-1.5">
                    {g.variants.map((v) => (
                        <button
                            type="button"
                            key={v.target}
                            onClick={() => setTarget(v.target)}
                            title={`chapters ${v.chapters.join(", ")}`}
                            className={cn(
                                "rounded-md border px-2.5 py-1 text-sm transition-colors hover:bg-accent",
                                target.trim().toLowerCase() === v.target.toLowerCase() && "border-brand/50 bg-brand/12 text-brand hover:bg-brand/18"
                            )}
                        >
                            {v.target}
                            <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{v.count}×</span>
                        </button>
                    ))}
                </div>

                {g.advice && (
                    <div className="flex gap-2.5 rounded-lg border border-brand/30 bg-brand/5 px-3 py-2.5 text-sm">
                        <Sparkles className="mt-0.5 size-4 shrink-0 text-brand" />
                        <div className="min-w-0">
                            <span className="font-medium">{g.advice.target}</span>
                            <span className="text-muted-foreground">
                                {" "}
                                · {g.advice.type}
                                {g.advice.type === "person" && ` · ${genderItems[g.advice.gender as GenderChoice] ?? g.advice.gender}`}
                            </span>
                            <p className="text-muted-foreground">{g.advice.reason}</p>
                        </div>
                    </div>
                )}

                <div className="grid gap-3 sm:grid-cols-[1fr_9rem_11rem]">
                    <div className="grid gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Translation</span>
                        <Input value={target} onChange={(e) => setTarget(e.target.value)} className="text-base" />
                    </div>
                    <div className="grid gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Type</span>
                        <Select value={type} onValueChange={(v) => v && setType(v as TermType)}>
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
                            <Select value={gender} onValueChange={(v) => v && setGender(v as GenderChoice)} items={genderItems}>
                                <SelectTrigger className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="m">male</SelectItem>
                                    <SelectItem value="f">female</SelectItem>
                                    <SelectItem value="unknown">unknown</SelectItem>
                                    {g.genders.length > 1 && <SelectItem value="timeline">{genderItems.timeline}</SelectItem>}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                    <div className="grid gap-1.5 sm:col-span-3">
                        <span className="text-xs font-medium text-muted-foreground">Note</span>
                        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="who or what it is" />
                    </div>
                </div>

                {open && (
                    <div className="grid gap-2">
                        {snippets === null ? (
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        ) : snippets.length === 0 ? (
                            <p className="text-sm text-muted-foreground">Not found in the sources.</p>
                        ) : (
                            snippets.map((s, i) => (
                                <div key={i} className="flex gap-2 rounded-lg bg-muted/40 px-3 py-2 text-sm">
                                    <Quote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0">
                                        <div className="mb-0.5 text-xs text-muted-foreground">
                                            chapter {s.chapter} · proposed “{s.target}”
                                        </div>
                                        <p className="font-serif break-words text-muted-foreground">
                                            {s.before}
                                            <mark className="rounded bg-brand/15 px-0.5 text-foreground">{s.match}</mark>
                                            {s.after}
                                        </p>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t bg-muted/20 px-5 py-3">
                <Button size="sm" disabled={pending || !target.trim()} onClick={merge}>
                    {pending ? <Loader2 className="animate-spin" /> : <Check />}
                    {g.existing ? "Save to the glossary" : "Add to the glossary"}
                </Button>
                <Button variant="outline" size="sm" disabled={asking} onClick={ask}>
                    {asking ? <Loader2 className="animate-spin" /> : <Sparkles />}
                    {g.advice ? "Ask again" : "Ask the model"}
                </Button>
                <Button variant="ghost" size="sm" onClick={showContext}>
                    <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
                    Context
                </Button>
                <div className="ml-auto flex gap-1">
                    {g.existing ? (
                        <Button variant="ghost" size="sm" disabled={pending} onClick={() => dismiss(false)}>
                            <Undo2 />
                            Keep “{g.existing.target}”
                        </Button>
                    ) : (
                        <Button variant="ghost" size="sm" disabled={pending} onClick={() => dismiss(true)}>
                            <Ban />
                            Not a term
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
