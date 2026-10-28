"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Gauge, Loader2 } from "lucide-react";
import { PROVIDER_DEFAULTS, type AskNewPolicy, type Provider } from "@ranobe-tl/core";
import { AskNewPicker, DecisionModePicker, Field, type KeyOption } from "@/components/novel/novel-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DecisionMode } from "@/db/schema";
import { saveInstance } from "@/server/actions/instance";
import type { InstanceConfig } from "@/server/instance";

export function InstancePanel({ config, keys, isAdmin }: { config: InstanceConfig; keys: KeyOption[]; isAdmin: boolean }) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const [concurrency, setConcurrency] = useState(String(config.concurrency));
    const d = config.defaults;
    const [keyId, setKeyId] = useState(d.providerKeyId ? String(d.providerKeyId) : "none");
    const [mode, setMode] = useState<DecisionMode>(d.decisionMode);
    const [askNew, setAskNew] = useState<AskNewPolicy | null>(d.askNew);

    return (
        <form
            className="grid gap-4"
            onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                start(async () => {
                    const res = await saveInstance({
                        concurrency: Number(concurrency),
                        defaults: {
                            sourceLanguage: String(f.get("sourceLanguage") || "English"),
                            targetLanguage: String(f.get("targetLanguage") || "Ukrainian"),
                            providerKeyId: keyId === "none" ? null : Number(keyId),
                            model: String(f.get("model") ?? "").trim(),
                            decisionMode: mode,
                            askNew,
                        },
                    });
                    if (!res.ok) return void toast.error(res.error);
                    toast.success(res.message ?? "Saved");
                    router.refresh();
                });
            }}
        >
            <section className="grid gap-4 rounded-xl border bg-card p-6 shadow-xs">
                <div className="flex gap-3">
                    <Gauge className="mt-0.5 size-4 shrink-0 text-brand" />
                    <div>
                        <h2 className="font-medium">Parallel translation</h2>
                        <p className="text-sm text-muted-foreground">
                            How many novels translate at the same time. Each novel is always one chapter at a time, in order. A key can have its own lower
                            limit in API keys (useful for rate limits or a local server that handles one request at a time).
                        </p>
                    </div>
                </div>
                <div className="flex items-end gap-3">
                    <Field label="Novels at once" htmlFor="concurrency" className="w-40">
                        <Input id="concurrency" type="number" min={1} max={32} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} disabled={!isAdmin} />
                    </Field>
                    <p className="pb-2 text-xs text-muted-foreground">Changes apply from the next chapter, no restart needed. A worker runs up to WORKER_SLOTS (8) at once.</p>
                </div>
            </section>

            <section className="grid gap-5 rounded-xl border bg-card p-6 shadow-xs">
                <div>
                    <h2 className="font-medium">Defaults for new novels</h2>
                    <p className="text-sm text-muted-foreground">Prefilled in “New novel”; every novel can change them later.</p>
                </div>
                <div className="grid gap-5 sm:grid-cols-2">
                    <Field label="Translate from" htmlFor="sourceLanguage">
                        <Input id="sourceLanguage" name="sourceLanguage" defaultValue={d.sourceLanguage} disabled={!isAdmin} />
                    </Field>
                    <Field label="Translate into" htmlFor="targetLanguage">
                        <Input id="targetLanguage" name="targetLanguage" defaultValue={d.targetLanguage} disabled={!isAdmin} />
                    </Field>
                    <Field label="API key">
                        <Select
                            value={keyId}
                            onValueChange={(v) => v && setKeyId(v)}
                            disabled={!isAdmin}
                            items={{ none: "The first key", ...Object.fromEntries(keys.map((k) => [String(k.id), `${k.name} · ${PROVIDER_DEFAULTS[k.provider as Provider]?.label ?? k.provider}`])) }}
                        >
                            <SelectTrigger className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="none">The first key</SelectItem>
                                {keys.map((k) => (
                                    <SelectItem key={k.id} value={String(k.id)}>
                                        {k.name} · {PROVIDER_DEFAULTS[k.provider as Provider]?.label ?? k.provider}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                    <Field label="Model" htmlFor="model" hint="Empty: the provider's default.">
                        <Input id="model" name="model" defaultValue={d.model} className="font-mono text-sm" disabled={!isAdmin} />
                    </Field>
                </div>
                <DecisionModePicker value={mode} onChange={setMode} />
                <AskNewPicker value={askNew} onChange={setAskNew} />
            </section>

            {isAdmin && (
                <div className="flex justify-end">
                    <Button type="submit" disabled={pending}>
                        {pending && <Loader2 className="animate-spin" />}
                        Save
                    </Button>
                </div>
            )}
        </form>
    );
}
