"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { ArrowDownAZ, BookMarked, Download, FileUp, History, Inbox, Languages, Loader2, Lock, LockOpen, MoreHorizontal, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { TERM_TYPES } from "@ranobe-tl/core";
import { EmptyState } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { cn, formatNumber } from "@/lib/utils";
import { affectedChapters, deleteTerms, importGlossary, retranslate, saveTerm, setLocked, termHistory, unignore } from "@/server/actions/glossary";

export interface GlossaryRow {
    id: number;
    source: string;
    target: string;
    type: string;
    note: string;
    locked: boolean;
    firstChapter: number | null;
    genders: { fromChapter: number; gender: string }[];
    gender: string | null;
    pending: number;
}

const TYPE_STYLE: Record<string, string> = {
    person: "bg-info/12 text-info",
    place: "bg-success/12 text-success",
    organization: "bg-brand/12 text-brand",
    technique: "bg-warning/16 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]",
    item: "bg-destructive/10 text-destructive",
    rank: "bg-muted text-foreground",
    creature: "bg-muted text-muted-foreground",
    other: "bg-muted text-muted-foreground",
};

const GENDER: Record<string, string> = { m: "♂ male", f: "♀ female", unknown: "? unknown" };

type Sort = "source" | "chapter" | "recent";

export function GlossaryTable({
    novelId,
    terms,
    initialQuery,
    ignored,
}: {
    novelId: number;
    terms: GlossaryRow[];
    initialQuery: string;
    ignored: { source: string; sourceNorm: string }[];
}) {
    const router = useRouter();
    const [q, setQ] = useState(initialQuery);
    const [type, setType] = useState<string>("all");
    const [sort, setSort] = useState<Sort>("source");
    const [editing, setEditing] = useState<GlossaryRow | "new" | null>(null);
    const [importing, setImporting] = useState(false);
    const [limit, setLimit] = useState(200);
    const [, start] = useTransition();

    const counts = useMemo(() => {
        const c: Record<string, number> = {};
        for (const t of terms) c[t.type] = (c[t.type] ?? 0) + 1;
        return c;
    }, [terms]);

    const filtered = useMemo(() => {
        const needle = q.trim().toLowerCase();
        const list = terms.filter(
            (t) =>
                (type === "all" || t.type === type) &&
                (!needle || t.source.toLowerCase().includes(needle) || t.target.toLowerCase().includes(needle) || t.note.toLowerCase().includes(needle))
        );
        if (sort === "source") list.sort((a, b) => a.source.localeCompare(b.source));
        if (sort === "chapter") list.sort((a, b) => (a.firstChapter ?? 0) - (b.firstChapter ?? 0) || a.id - b.id);
        if (sort === "recent") list.sort((a, b) => b.id - a.id);
        return list;
    }, [terms, q, type, sort]);

    useEffect(() => setLimit(200), [q, type, sort]);

    const toggleLock = (t: GlossaryRow) =>
        start(async () => {
            const res = await setLocked(novelId, [t.id], !t.locked);
            if (!res.ok) toast.error(res.error);
            router.refresh();
        });

    if (!terms.length) {
        return (
            <>
                <EmptyState
                    icon={BookMarked}
                    title="The glossary is empty"
                    description="It fills up by itself while chapters are translated: the model reports names, places and techniques it meets. You can also add terms by hand or import a JSON file."
                >
                    <Button onClick={() => setEditing("new")}>
                        <Plus />
                        Add a term
                    </Button>
                    <Button variant="outline" onClick={() => setImporting(true)}>
                        <FileUp />
                        Import JSON
                    </Button>
                </EmptyState>
                <TermDialog novelId={novelId} term={editing} onClose={() => setEditing(null)} />
                <ImportDialog novelId={novelId} open={importing} onOpenChange={setImporting} />
            </>
        );
    }

    return (
        <div className="grid gap-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
                <div className="relative flex-1">
                    <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${formatNumber(terms.length)} terms`} className="pl-8" />
                </div>
                <div className="flex gap-2">
                    <Select value={type} onValueChange={setType}>
                        <SelectTrigger className="w-40">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All types</SelectItem>
                            {TERM_TYPES.filter((t) => counts[t]).map((t) => (
                                <SelectItem key={t} value={t}>
                                    {t} <span className="text-muted-foreground">{counts[t]}</span>
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
                        <SelectTrigger className="w-36">
                            <ArrowDownAZ />
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="source">A → Z</SelectItem>
                            <SelectItem value="chapter">First seen</SelectItem>
                            <SelectItem value="recent">Newest</SelectItem>
                        </SelectContent>
                    </Select>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="outline" size="icon" aria-label="Import or export">
                                <MoreHorizontal />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setImporting(true)}>
                                <FileUp />
                                Import JSON…
                            </DropdownMenuItem>
                            <DropdownMenuItem asChild>
                                <a href={`/api/novels/${novelId}/glossary`}>
                                    <Download />
                                    Export JSON
                                </a>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                    <Button onClick={() => setEditing("new")}>
                        <Plus />
                        <span className="hidden sm:inline">Add term</span>
                    </Button>
                </div>
            </div>

            <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
                <Table>
                    <TableHeader>
                        <TableRow className="hover:bg-transparent">
                            <TableHead className="pl-4">Original</TableHead>
                            <TableHead>Translation</TableHead>
                            <TableHead className="w-28">Type</TableHead>
                            <TableHead className="hidden w-28 md:table-cell">Gender</TableHead>
                            <TableHead className="hidden w-20 text-right lg:table-cell">Since</TableHead>
                            <TableHead className="w-20" />
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {filtered.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={6} className="py-12 text-center text-muted-foreground">
                                    No terms match.
                                </TableCell>
                            </TableRow>
                        )}
                        {filtered.slice(0, limit).map((t) => (
                            <TableRow key={t.id} className="cursor-pointer" onClick={() => setEditing(t)}>
                                <TableCell className="max-w-0 pl-4 whitespace-normal">
                                    <div className="flex items-center gap-1.5">
                                        <span className="truncate font-medium">{t.source}</span>
                                        {t.pending > 0 && (
                                            <Badge variant="warning" className="px-1.5 py-0">
                                                <Inbox />
                                                {t.pending}
                                            </Badge>
                                        )}
                                    </div>
                                    {t.note && <div className="truncate text-xs text-muted-foreground">{t.note}</div>}
                                </TableCell>
                                <TableCell className="max-w-0 truncate whitespace-normal">{t.target}</TableCell>
                                <TableCell>
                                    <span className={cn("rounded-md px-1.5 py-0.5 text-xs font-medium", TYPE_STYLE[t.type] ?? TYPE_STYLE.other)}>{t.type}</span>
                                </TableCell>
                                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">
                                    {t.gender ? (
                                        <span title={t.genders.map((g) => `${g.gender} from ch. ${g.fromChapter}`).join(", ")}>
                                            {GENDER[t.gender] ?? t.gender}
                                            {t.genders.length > 1 && <span className="ml-1 text-brand">· changes</span>}
                                        </span>
                                    ) : (
                                        "—"
                                    )}
                                </TableCell>
                                <TableCell className="hidden text-right font-mono text-xs text-muted-foreground lg:table-cell">{t.firstChapter ?? "—"}</TableCell>
                                <TableCell className="pr-3 text-right" onClick={(e) => e.stopPropagation()}>
                                    <Button variant="ghost" size="icon-xs" onClick={() => toggleLock(t)} aria-label={t.locked ? "Unlock" : "Lock"} className={cn(!t.locked && "text-muted-foreground/40")}>
                                        {t.locked ? <Lock /> : <LockOpen />}
                                    </Button>
                                    <Button variant="ghost" size="icon-xs" onClick={() => setEditing(t)} aria-label="Edit">
                                        <Pencil />
                                    </Button>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>
            {filtered.length > limit && (
                <Button variant="outline" className="mx-auto" onClick={() => setLimit((l) => l + 300)}>
                    Show more ({formatNumber(filtered.length - limit)} left)
                </Button>
            )}
            <p className="text-xs text-muted-foreground">
                Locked terms never change: the model may still propose something else, but it is rejected without asking.
            </p>
            {ignored.length > 0 && (
                <details className="rounded-xl border bg-card px-4 py-3 text-sm shadow-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                        {ignored.length} {ignored.length === 1 ? "source is" : "sources are"} marked “not a term” and never added again
                    </summary>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        {ignored.map((i) => (
                            <span key={i.sourceNorm} className="flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2 text-xs">
                                {i.source}
                                <Button
                                    variant="ghost"
                                    size="xs"
                                    className="h-5 px-1.5 text-muted-foreground"
                                    onClick={() =>
                                        start(async () => {
                                            const res = await unignore(novelId, i.sourceNorm);
                                            if (!res.ok) toast.error(res.error);
                                            router.refresh();
                                        })
                                    }
                                >
                                    restore
                                </Button>
                            </span>
                        ))}
                    </div>
                </details>
            )}
            <TermDialog novelId={novelId} term={editing} onClose={() => setEditing(null)} />
            <ImportDialog novelId={novelId} open={importing} onOpenChange={setImporting} />
        </div>
    );
}

interface HistoryRow {
    id: number;
    field: string;
    oldValue: string;
    newValue: string;
    chapter: number | null;
    reason: string;
    evidence: string;
    status: string;
    createdAt: string;
}

function TermDialog({ novelId, term, onClose }: { novelId: number; term: GlossaryRow | "new" | null; onClose: () => void }) {
    const router = useRouter();
    const isNew = term === "new";
    const t = term && term !== "new" ? term : null;
    const [type, setType] = useState("other");
    const [gender, setGender] = useState("unknown");
    const [locked, setLockedState] = useState(false);
    const [history, setHistory] = useState<HistoryRow[] | null>(null);
    const [affected, setAffected] = useState<number[] | null>(null);
    const [pending, start] = useTransition();
    const form = useRef<HTMLFormElement>(null);

    useEffect(() => {
        if (!term) return;
        setType(t?.type ?? "person");
        setGender(t?.gender ?? "unknown");
        setLockedState(t?.locked ?? false);
        setHistory(null);
        setAffected(null);
        if (t) {
            termHistory(novelId, t.id).then((r) => r.ok && setHistory(r.data ?? []));
        }
    }, [term, t, novelId]);

    function submit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const genderFrom = Number(f.get("genderFrom")) || undefined;
        start(async () => {
            const res = await saveTerm(novelId, t?.id ?? null, {
                source: String(f.get("source")),
                target: String(f.get("target")),
                type: type as (typeof TERM_TYPES)[number],
                note: String(f.get("note") ?? ""),
                locked,
                gender: type === "person" ? (gender as "m" | "f" | "unknown") : undefined,
                genderFrom: t && gender !== t.gender ? genderFrom : undefined,
            });
            if (!res.ok) return void toast.error(res.error);
            toast.success(isNew ? "Term added" : "Saved");
            router.refresh();
            if (isNew || !t || t.target === String(f.get("target"))) onClose();
            else {
                const a = await affectedChapters(novelId, [t.id]);
                if (a.ok && a.data?.length) setAffected(a.data);
                else onClose();
            }
        });
    }

    return (
        <Dialog open={!!term} onOpenChange={(v) => !v && onClose()}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>{isNew ? "Add a term" : t?.source}</DialogTitle>
                    <DialogDescription>{isNew ? "It is sent to the model whenever the term occurs in a chapter." : t?.firstChapter ? `First seen in chapter ${t.firstChapter}.` : "Added by hand or imported."}</DialogDescription>
                </DialogHeader>
                {affected ? (
                    <div className="grid gap-4">
                        <div className="rounded-lg border bg-muted/40 p-4 text-sm">
                            <div className="font-medium">{affected.length} translated chapters use this term</div>
                            <p className="mt-1 text-muted-foreground">
                                They still have the old translation. Translate them again to apply the change everywhere (chapters {affected.slice(0, 12).join(", ")}
                                {affected.length > 12 ? "…" : ""}).
                            </p>
                        </div>
                        <DialogFooter>
                            <Button variant="ghost" onClick={onClose}>
                                Not now
                            </Button>
                            <Button
                                disabled={pending}
                                onClick={() =>
                                    start(async () => {
                                        const res = await retranslate(novelId, affected);
                                        if (!res.ok) return void toast.error(res.error);
                                        toast.success(res.message ?? "Queued");
                                        router.refresh();
                                        onClose();
                                    })
                                }
                            >
                                {pending ? <Loader2 className="animate-spin" /> : <Languages />}
                                Translate {affected.length} again
                            </Button>
                        </DialogFooter>
                    </div>
                ) : (
                    <form ref={form} onSubmit={submit} className="grid gap-4" key={t?.id ?? "new"}>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="grid gap-2">
                                <Label htmlFor="source">Original</Label>
                                <Input id="source" name="source" defaultValue={t?.source} required autoFocus={isNew} />
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="target">Translation</Label>
                                <Input id="target" name="target" defaultValue={t?.target} required />
                            </div>
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="grid gap-2">
                                <Label>Type</Label>
                                <Select value={type} onValueChange={setType}>
                                    <SelectTrigger className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {TERM_TYPES.map((x) => (
                                            <SelectItem key={x} value={x}>
                                                {x}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                            {type === "person" && (
                                <div className="grid gap-2">
                                    <Label>Gender</Label>
                                    <Select value={gender} onValueChange={setGender}>
                                        <SelectTrigger className="w-full">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="m">Male</SelectItem>
                                            <SelectItem value="f">Female</SelectItem>
                                            <SelectItem value="unknown">Unknown</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            )}
                        </div>
                        {type === "person" && t && gender !== t.gender && (
                            <div className="grid gap-2 rounded-lg bg-muted/50 p-3">
                                <Label htmlFor="genderFrom">From chapter</Label>
                                <Input id="genderFrom" name="genderFrom" type="number" min={1} defaultValue={1} className="w-32" />
                                <p className="text-xs text-muted-foreground">1 rewrites the whole history; a later chapter keeps the old gender before it.</p>
                            </div>
                        )}
                        <div className="grid gap-2">
                            <Label htmlFor="note">Note</Label>
                            <Textarea id="note" name="note" defaultValue={t?.note} rows={2} placeholder="Context for the model: who this is, what it means" />
                        </div>
                        <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
                            <span>
                                <span className="block text-sm font-medium">Locked</span>
                                <span className="block text-xs text-muted-foreground">Proposals to change it are rejected without asking.</span>
                            </span>
                            <Switch checked={locked} onCheckedChange={setLockedState} />
                        </label>
                        {t && history && history.length > 0 && (
                            <div className="grid gap-2">
                                <div className="flex items-center gap-1.5 text-sm font-medium">
                                    <History className="size-4 text-muted-foreground" />
                                    History
                                </div>
                                <ul className="scrollbar-thin max-h-40 divide-y overflow-y-auto rounded-lg border text-xs">
                                    {history.map((h) => (
                                        <li key={h.id} className="flex items-start gap-2 px-3 py-2">
                                            <Badge variant={h.status === "applied" ? "success" : h.status === "pending" ? "warning" : "muted"} className="mt-px">
                                                {h.status}
                                            </Badge>
                                            <div className="min-w-0 flex-1">
                                                <span className="text-muted-foreground">{h.field}: </span>
                                                <span className="line-through opacity-60">{h.oldValue}</span> → <span className="font-medium">{h.newValue}</span>
                                                {h.reason && <div className="text-muted-foreground">{h.reason}</div>}
                                            </div>
                                            <span className="shrink-0 text-muted-foreground">{h.chapter ? `ch. ${h.chapter}` : ""}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                        <DialogFooter className="sm:justify-between">
                            {t ? (
                                <Button
                                    type="button"
                                    variant="ghost"
                                    className="text-destructive hover:text-destructive"
                                    onClick={() =>
                                        start(async () => {
                                            const res = await deleteTerms(novelId, [t.id]);
                                            if (!res.ok) return void toast.error(res.error);
                                            toast.success("Term deleted");
                                            router.refresh();
                                            onClose();
                                        })
                                    }
                                >
                                    <Trash2 />
                                    Delete
                                </Button>
                            ) : (
                                <span />
                            )}
                            <div className="flex gap-2">
                                <Button type="button" variant="ghost" onClick={onClose}>
                                    Cancel
                                </Button>
                                <Button type="submit" disabled={pending}>
                                    {pending && <Loader2 className="animate-spin" />}
                                    {isNew ? "Add" : "Save"}
                                </Button>
                            </div>
                        </DialogFooter>
                    </form>
                )}
            </DialogContent>
        </Dialog>
    );
}

function ImportDialog({ novelId, open, onOpenChange }: { novelId: number; open: boolean; onOpenChange: (v: boolean) => void }) {
    const router = useRouter();
    const [text, setText] = useState("");
    const [pending, start] = useTransition();
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-xl">
                <DialogHeader>
                    <DialogTitle>Import a glossary</DialogTitle>
                    <DialogDescription>
                        A JSON array of <code className="text-xs">{`{"source", "target", "type", "note", "gender"}`}</code>, or the old flat{" "}
                        <code className="text-xs">{`{"term": "переклад (чоловік)"}`}</code> file. Existing terms are kept.
                    </DialogDescription>
                </DialogHeader>
                <Input
                    type="file"
                    accept=".json,application/json"
                    onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (f) setText(await f.text());
                    }}
                />
                <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="…or paste JSON here" className="h-48 font-mono text-xs [field-sizing:fixed]" />
                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button
                        disabled={!text.trim() || pending}
                        onClick={() =>
                            start(async () => {
                                const res = await importGlossary(novelId, text);
                                if (!res.ok) return void toast.error(res.error);
                                toast.success(res.message ?? "Imported");
                                setText("");
                                onOpenChange(false);
                                router.refresh();
                            })
                        }
                    >
                        {pending ? <Loader2 className="animate-spin" /> : <FileUp />}
                        Import
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
