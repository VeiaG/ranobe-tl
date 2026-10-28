"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Hourglass, ListChecks, Loader2 } from "lucide-react";
import { PROVIDER_DEFAULTS, type Provider } from "@ranobe-tl/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

export function NovelForm({ keys, initial, novelId }: { keys: KeyOption[]; initial?: Partial<NovelInput>; novelId?: number }) {
    const [pending, start] = useTransition();
    const [keyId, setKeyId] = useState<string>(initial?.providerKeyId ? String(initial.providerKeyId) : keys[0] ? String(keys[0].id) : "");
    const [mode, setMode] = useState<DecisionMode>((initial?.decisionMode as DecisionMode) ?? "queue");
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
                        <Select value={keyId} onValueChange={setKeyId} disabled={!keys.length}>
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
                    <h2 className="font-medium">When the model wants to change a term</h2>
                    <p className="text-sm text-muted-foreground">New terms are always added on their own. This is about changing a translation or a gender that is already in the glossary.</p>
                </div>
                <DecisionModePicker value={mode} onChange={setMode} />
            </section>

            <div className="flex justify-end gap-2 border-t pt-6">
                {!novelId && (
                    <Button variant="ghost" asChild>
                        <Link href="/">Cancel</Link>
                    </Button>
                )}
                <Button type="submit" disabled={pending}>
                    {pending && <Loader2 className="animate-spin" />}
                    {novelId ? "Save changes" : "Create and upload chapters"}
                </Button>
            </div>
        </form>
    );
}
