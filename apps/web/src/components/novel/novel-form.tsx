"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Hourglass, ListChecks, Loader2 } from "lucide-react";
import { PROVIDER_DEFAULTS, TERM_TYPES, type AskNewPolicy, type Provider, type TermType } from "@ranobe-tl/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { DecisionMode } from "@/db/schema";
import { cn } from "@/lib/utils";
import { createNovel, updateNovel, type NovelInput } from "@/server/actions/novels";

export interface KeyOption {
    id: number;
    name: string;
    provider: string;
    hint: string;
}

export function Field({ label, hint, htmlFor, children, className }: { label: string; hint?: React.ReactNode; htmlFor?: string; children: React.ReactNode; className?: string }) {
    return (
        <div className={cn("grid gap-2", className)}>
            <Label htmlFor={htmlFor}>{label}</Label>
            {children}
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

export function DecisionModePicker({ value, onChange }: { value: DecisionMode; onChange: (v: DecisionMode) => void }) {
    const options: { value: DecisionMode; title: string; text: string; icon: React.ComponentType<{ className?: string }> }[] = [
        {
            value: "queue",
            title: "Keep going",
            text: "Translate with the current glossary; proposals wait in Decisions. Accepting one can re-translate the chapters that use it.",
            icon: ListChecks,
        },
        {
            value: "pause",
            title: "Stop and ask",
            text: "When a chapter proposes changing a term, the novel waits for you and translates that chapter again after you decide. Other novels keep running.",
            icon: Hourglass,
        },
    ];
    return (
        <div className="grid gap-3 sm:grid-cols-2">
            {options.map((o) => (
                <button
                    type="button"
                    key={o.value}
                    onClick={() => onChange(o.value)}
                    className={cn(
                        "flex gap-3 rounded-lg border p-3.5 text-left transition-colors hover:bg-accent/50",
                        value === o.value && "border-brand/60 bg-brand/5 ring-1 ring-brand/30"
                    )}
                >
                    <o.icon className={cn("mt-0.5 size-4 shrink-0 text-muted-foreground", value === o.value && "text-brand")} />
                    <span>
                        <span className="block text-sm font-medium">{o.title}</span>
                        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{o.text}</span>
                    </span>
                </button>
            ))}
        </div>
    );
}

/** Opt-in review of new terms: which types, and up to which chapter. */
export function AskNewPicker({ value, onChange }: { value: AskNewPolicy | null; onChange: (v: AskNewPolicy | null) => void }) {
    const on = value !== null;
    const types = value?.types ?? [];
    const toggleType = (t: TermType) => {
        const next = types.includes(t) ? types.filter((x) => x !== t) : [...types, t];
        onChange({ ...value, types: next.length ? next : undefined });
    };
    return (
        <div className={cn("rounded-lg border p-3.5 transition-colors", on && "border-brand/60 bg-brand/5 ring-1 ring-brand/30")}>
            <label className="flex items-start justify-between gap-4">
                <span>
                    <span className="block text-sm font-medium">Also review new terms</span>
                    <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        Every new name the model finds is added right away and also shows up in Decisions: confirm it, fix the translation, type or gender, or
                        remove it as “not a term”. Catches mistakes before they spread through hundreds of chapters.
                    </span>
                </span>
                <Switch checked={on} onCheckedChange={(v) => onChange(v ? { types: ["person", "place", "organization"] } : null)} />
            </label>
            {on && (
                <div className="mt-4 grid gap-4 border-t pt-4">
                    <div className="grid gap-2">
                        <span className="text-xs font-medium text-muted-foreground">Only these types (none selected = all)</span>
                        <div className="flex flex-wrap gap-1.5">
                            {TERM_TYPES.map((t) => (
                                <button
                                    type="button"
                                    key={t}
                                    onClick={() => toggleType(t)}
                                    className={cn(
                                        "rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent",
                                        types.includes(t) && "border-brand/50 bg-brand/12 text-brand hover:bg-brand/18"
                                    )}
                                >
                                    {t}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="grid max-w-56 gap-2">
                        <Label htmlFor="untilChapter" className="text-xs text-muted-foreground">
                            Only until chapter
                        </Label>
                        <Input
                            id="untilChapter"
                            type="number"
                            min={1}
                            placeholder="always"
                            value={value?.untilChapter ?? ""}
                            onChange={(e) => onChange({ ...value, untilChapter: e.target.value ? Number(e.target.value) : undefined })}
                        />
                        <p className="text-xs text-muted-foreground">The main cast shows up early; later chapters can run on their own.</p>
                    </div>
                </div>
            )}
        </div>
    );
}

export function NovelForm({ keys, initial, novelId }: { keys: KeyOption[]; initial?: Partial<NovelInput>; novelId?: number }) {
    const [pending, start] = useTransition();
    const [keyId, setKeyId] = useState<string>(initial?.providerKeyId ? String(initial.providerKeyId) : keys[0] ? String(keys[0].id) : "");
    const [mode, setMode] = useState<DecisionMode>((initial?.decisionMode as DecisionMode) ?? "queue");
    const [askNew, setAskNew] = useState<AskNewPolicy | null>((initial?.askNew as AskNewPolicy | null | undefined) ?? null);
    const key = keys.find((k) => String(k.id) === keyId);
    const defaultModel = key ? PROVIDER_DEFAULTS[key.provider as Provider]?.model : undefined;

    function onSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const input: NovelInput = {
            title: String(f.get("title") ?? ""),
            originalTitle: String(f.get("originalTitle") ?? ""),
            synopsis: String(f.get("synopsis") ?? ""),
            sourceLanguage: String(f.get("sourceLanguage") ?? "English"),
            targetLanguage: String(f.get("targetLanguage") ?? "Ukrainian"),
            providerKeyId: keyId ? Number(keyId) : null,
            model: String(f.get("model") ?? ""),
            decisionMode: mode,
            askNew,
        };
        start(async () => {
            const res = novelId ? await updateNovel(novelId, input) : await createNovel(input);
            if (!res.ok) toast.error(res.error);
            else if (novelId) toast.success("Saved");
        });
    }

    return (
        <form onSubmit={onSubmit} className="grid gap-8">
            <section className="grid gap-5">
                <div>
                    <h2 className="font-medium">The novel</h2>
                    <p className="text-sm text-muted-foreground">Title and synopsis are given to the model as background.</p>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                    <Field label="Title" htmlFor="title">
                        <Input id="title" name="title" defaultValue={initial?.title} required placeholder="How you call it" />
                    </Field>
                    <Field label="Original title" htmlFor="originalTitle" hint="Optional, as the source names it.">
                        <Input id="originalTitle" name="originalTitle" defaultValue={initial?.originalTitle} />
                    </Field>
                </div>
                <Field label="Synopsis" htmlFor="synopsis" hint="A few sentences about the setting and the main characters help with tone and names.">
                    <Textarea id="synopsis" name="synopsis" defaultValue={initial?.synopsis} rows={4} className="min-h-24" />
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                    <Field label="Translate from" htmlFor="sourceLanguage">
                        <Input id="sourceLanguage" name="sourceLanguage" defaultValue={initial?.sourceLanguage ?? "English"} required />
                    </Field>
                    <Field label="Translate into" htmlFor="targetLanguage">
                        <Input id="targetLanguage" name="targetLanguage" defaultValue={initial?.targetLanguage ?? "Ukrainian"} required />
                    </Field>
                </div>
            </section>

            <section className="grid gap-5">
                <div>
                    <h2 className="font-medium">Model</h2>
                    <p className="text-sm text-muted-foreground">Which key pays for this novel and which model translates it.</p>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                    <Field
                        label="API key"
                        hint={
                            keys.length ? undefined : (
                                <>
                                    No keys yet:{" "}
                                    <Link href="/settings?tab=keys" className="text-brand hover:underline">
                                        add one in Settings
                                    </Link>
                                    .
                                </>
                            )
                        }
                    >
                        <Select
                            value={keyId}
                            onValueChange={(v) => v && setKeyId(v)}
                            disabled={!keys.length}
                            items={Object.fromEntries(keys.map((k) => [String(k.id), `${k.name} · ${PROVIDER_DEFAULTS[k.provider as Provider]?.label ?? k.provider} ···${k.hint}`]))}
                        >
                            <SelectTrigger className="w-full">
                                <SelectValue placeholder="Choose a key" />
                            </SelectTrigger>
                            <SelectContent>
                                {keys.map((k) => (
                                    <SelectItem key={k.id} value={String(k.id)}>
                                        {k.name}
                                        <span className="text-muted-foreground">
                                            · {PROVIDER_DEFAULTS[k.provider as Provider]?.label ?? k.provider} ···{k.hint}
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                    <Field label="Model" htmlFor="model" hint={defaultModel ? `Leave empty for ${defaultModel}.` : key ? "Required for this provider." : undefined}>
                        <Input id="model" name="model" defaultValue={initial?.model} placeholder={defaultModel ?? "model id"} className="font-mono text-sm" />
                    </Field>
                </div>
            </section>

            <section className="grid gap-4">
                <div>
                    <h2 className="font-medium">Glossary decisions</h2>
                    <p className="text-sm text-muted-foreground">
                        The model may propose changing a translation or a gender that is already in the glossary. How should the run treat that (and new terms, if you review them)?
                    </p>
                </div>
                <DecisionModePicker value={mode} onChange={setMode} />
                <AskNewPicker value={askNew} onChange={setAskNew} />
            </section>

            <div className="flex justify-end gap-2 border-t pt-6">
                {!novelId && (
                    <Button variant="ghost" nativeButton={false} render={<Link href="/" />}>Cancel</Button>
                )}
                <Button type="submit" disabled={pending}>
                    {pending && <Loader2 className="animate-spin" />}
                    {novelId ? "Save changes" : "Create and upload chapters"}
                </Button>
            </div>
        </form>
    );
}
