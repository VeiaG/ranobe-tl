"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { KeyRound, Loader2, Plus, Trash2, Zap } from "lucide-react";
import { PROVIDERS, PROVIDER_DEFAULTS, type Provider } from "@ranobe-tl/core";
import { Field } from "@/components/novel/novel-form";
import { EmptyState } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn, timeAgo } from "@/lib/utils";
import { addKey, deleteKey, setKeyBudget, testKey } from "@/server/actions/keys";

interface KeyRow {
    id: number;
    name: string;
    provider: string;
    baseURL: string | null;
    hint: string;
    createdAt: string;
    novels: number;
    monthlyBudgetUsd: number | null;
    spentThisMonth: number;
}

function usd(n: number) {
    return n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

/** This month's spend against the key's monthly cap; click to change the cap. */
function KeyBudget({ k, isAdmin }: { k: KeyRow; isAdmin: boolean }) {
    const router = useRouter();
    const [editing, setEditing] = useState(false);
    const [value, setValue] = useState(k.monthlyBudgetUsd === null ? "" : String(k.monthlyBudgetUsd));
    const [pending, start] = useTransition();
    const over = k.monthlyBudgetUsd !== null && k.spentThisMonth >= k.monthlyBudgetUsd;
    if (editing) {
        return (
            <form
                className="flex items-center gap-1"
                onSubmit={(e) => {
                    e.preventDefault();
                    start(async () => {
                        const res = await setKeyBudget(k.id, value.trim() ? Number(value) : null);
                        if (!res.ok) return void toast.error(res.error);
                        setEditing(false);
                        router.refresh();
                    });
                }}
            >
                <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="no cap" inputMode="decimal" className="h-7 w-24 text-right text-xs" />
                <Button type="submit" size="xs" disabled={pending}>
                    Save
                </Button>
            </form>
        );
    }
    return (
        <button
            type="button"
            disabled={!isAdmin}
            onClick={() => setEditing(true)}
            title={isAdmin ? "Set a monthly budget" : undefined}
            className={cn("rounded-md px-1.5 py-0.5 text-right text-xs tabular-nums hover:bg-muted disabled:hover:bg-transparent", over ? "text-destructive" : "text-muted-foreground")}
        >
            <span className={cn("font-medium", !over && "text-foreground")}>{usd(k.spentThisMonth)}</span>
            {k.monthlyBudgetUsd !== null ? ` / ${usd(k.monthlyBudgetUsd)}` : ""} this month
        </button>
    );
}

const PROVIDER_STYLE: Record<string, string> = {
    openai: "bg-success/12 text-success",
    anthropic: "bg-warning/16 text-[color-mix(in_oklch,var(--warning)_70%,var(--foreground))]",
    google: "bg-info/12 text-info",
};

export function KeysPanel({ keys, isAdmin }: { keys: KeyRow[]; isAdmin: boolean }) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState<number | null>(null);
    const [, start] = useTransition();

    const test = (id: number) => {
        setBusy(id);
        start(async () => {
            const res = await testKey(id);
            setBusy(null);
            if (!res.ok) toast.error(res.error, { duration: 10000 });
            else toast.success(res.message ?? "Works");
        });
    };

    return (
        <div className="grid gap-4">
            <div className="flex items-center justify-between gap-4">
                <p className="text-sm text-muted-foreground">Keys are encrypted with APP_SECRET and never shown again. Each novel picks one.</p>
                {isAdmin && (
                    <Button onClick={() => setOpen(true)}>
                        <Plus />
                        Add key
                    </Button>
                )}
            </div>
            {keys.length === 0 ? (
                <EmptyState icon={KeyRound} title="No API keys" description={isAdmin ? "Add an OpenAI, Anthropic or Google key, or any OpenAI-compatible endpoint (OpenRouter, a local server…)." : "Ask the admin to add one."} />
            ) : (
                <div className="divide-y rounded-xl border bg-card shadow-xs">
                    {keys.map((k) => (
                        <div key={k.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                            <div className="flex size-9 items-center justify-center rounded-lg bg-muted">
                                <KeyRound className="size-4 text-muted-foreground" />
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium">{k.name}</span>
                                    <span className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${PROVIDER_STYLE[k.provider] ?? ""}`}>{PROVIDER_DEFAULTS[k.provider as Provider]?.label ?? k.provider}</span>
                                </div>
                                <div className="truncate text-xs text-muted-foreground">
                                    <span className="font-mono">···{k.hint}</span>
                                    {k.baseURL && <span className="font-mono"> · {k.baseURL}</span>} · added {timeAgo(k.createdAt)}
                                </div>
                            </div>
                            <KeyBudget k={k} isAdmin={isAdmin} />
                            <Badge variant="muted">{k.novels === 1 ? "1 novel" : `${k.novels} novels`}</Badge>
                            <Button variant="outline" size="sm" onClick={() => test(k.id)} disabled={busy === k.id}>
                                {busy === k.id ? <Loader2 className="animate-spin" /> : <Zap />}
                                Test
                            </Button>
                            {isAdmin && (
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="Delete key"
                                    onClick={() =>
                                        start(async () => {
                                            if (!confirm(`Delete the key “${k.name}”? Novels using it will need another one.`)) return;
                                            const res = await deleteKey(k.id);
                                            if (!res.ok) toast.error(res.error);
                                            router.refresh();
                                        })
                                    }
                                >
                                    <Trash2 />
                                </Button>
                            )}
                        </div>
                    ))}
                </div>
            )}
            <AddKeyDialog open={open} onOpenChange={setOpen} />
        </div>
    );
}

function AddKeyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
    const router = useRouter();
    const [provider, setProvider] = useState<Provider>("openai");
    const [pending, start] = useTransition();
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Add an API key</DialogTitle>
                    <DialogDescription>For OpenRouter or a local OpenAI-compatible server choose OpenAI and set the base URL.</DialogDescription>
                </DialogHeader>
                <form
                    className="grid gap-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        start(async () => {
                            const res = await addKey({ name: String(f.get("name")), provider, apiKey: String(f.get("apiKey")), baseURL: String(f.get("baseURL") ?? "") });
                            if (!res.ok) return void toast.error(res.error);
                            toast.success("Key added");
                            onOpenChange(false);
                            router.refresh();
                        });
                    }}
                >
                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Provider">
                            <Select value={provider} onValueChange={(v) => v && setProvider(v as Provider)} items={Object.fromEntries(PROVIDERS.map((p) => [p, PROVIDER_DEFAULTS[p].label]))}>
                                <SelectTrigger className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {PROVIDERS.map((p) => (
                                        <SelectItem key={p} value={p}>
                                            {PROVIDER_DEFAULTS[p].label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field label="Name" htmlFor="name">
                            <Input id="name" name="name" placeholder={`${PROVIDER_DEFAULTS[provider].label} personal`} />
                        </Field>
                    </div>
                    <Field label="Key" htmlFor="apiKey">
                        <Input id="apiKey" name="apiKey" type="password" autoComplete="off" required className="font-mono" placeholder={provider === "anthropic" ? "sk-ant-…" : provider === "openai" ? "sk-…" : "AIza…"} />
                    </Field>
                    <Field label="Base URL" htmlFor="baseURL" hint="Optional: a proxy or a compatible endpoint.">
                        <Input id="baseURL" name="baseURL" placeholder={provider === "openai" ? "https://openrouter.ai/api/v1" : ""} className="font-mono text-sm" />
                    </Field>
                    <DialogFooter>
                        <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={pending}>
                            {pending && <Loader2 className="animate-spin" />}
                            Add key
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}
