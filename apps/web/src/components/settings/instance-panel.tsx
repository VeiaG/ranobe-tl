"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Gauge, Loader2, MessagesSquare, Sparkles } from "lucide-react";
import { EFFORTS, PROVIDER_DEFAULTS, type AskNewPolicy, type Provider } from "@ranobe-tl/core";
import { AskNewPicker, DecisionModePicker, Field, ModelPicker, type KeyOption } from "@/components/novel/novel-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { DecisionMode } from "@/db/schema";
import { saveInstance } from "@/server/actions/instance";
import type { InstanceConfig, ModelChoice } from "@/server/instance";

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
                        service: readChoice(f, "service"),
                        assistant: readChoice(f, "assistant"),
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

            <ModelChoiceSection
                icon={Sparkles}
                title="Service model"
                description="Does small jobs around the translation, such as writing cleanup patterns from a description (the ✨ button in a novel's settings). A small, cheap model is enough. Its requests count in Usage like any other."
                name="service"
                choice={config.service}
                keys={keys}
                isAdmin={isAdmin}
                noKey="Not set"
            />
            <ModelChoiceSection
                icon={MessagesSquare}
                title="Assistant model"
                description="Chats in a novel's Replace tab: searches the translations and proposes edits for you to confirm (fixing an old term in every grammatical form, for example). It has to use tools and know the target language well, so a capable model pays off."
                name="assistant"
                choice={config.assistant}
                keys={keys}
                isAdmin={isAdmin}
                noKey="The service model"
            />

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

/** The fields of ModelChoiceSection come back as `<name>Key`, `<name>Model` and `<name>Effort`. */
function readChoice(f: FormData, name: string): ModelChoice {
    const key = String(f.get(`${name}Key`) ?? "none");
    const effort = String(f.get(`${name}Effort`) ?? "default");
    return {
        providerKeyId: key === "none" ? null : Number(key),
        model: String(f.get(`${name}Model`) ?? "").trim(),
        effort: effort === "default" ? null : (effort as ModelChoice["effort"]),
    };
}

function ModelChoiceSection(props: {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    description: string;
    name: string;
    choice: ModelChoice;
    keys: KeyOption[];
    isAdmin: boolean;
    /** What happens without a key. */
    noKey: string;
}) {
    const { icon: Icon, name, keys, isAdmin } = props;
    const [keyId, setKeyId] = useState(props.choice.providerKeyId ? String(props.choice.providerKeyId) : "none");
    const [effort, setEffort] = useState<string>(props.choice.effort ?? "default");
    const key = keys.find((k) => String(k.id) === keyId);
    const label = (k: KeyOption) => `${k.name} · ${PROVIDER_DEFAULTS[k.provider as Provider]?.label ?? k.provider}`;

    return (
        <section className="grid gap-5 rounded-xl border bg-card p-6 shadow-xs">
            <input type="hidden" name={`${name}Key`} value={keyId} />
            <input type="hidden" name={`${name}Effort`} value={effort} />
            <div className="flex gap-3">
                <Icon className="mt-0.5 size-4 shrink-0 text-brand" />
                <div>
                    <h2 className="font-medium">{props.title}</h2>
                    <p className="text-sm text-muted-foreground">{props.description}</p>
                </div>
            </div>
            <div className="grid gap-5 sm:grid-cols-3">
                <Field label="API key">
                    <Select value={keyId} onValueChange={(v) => v && setKeyId(v)} disabled={!isAdmin} items={{ none: props.noKey, ...Object.fromEntries(keys.map((k) => [String(k.id), label(k)])) }}>
                        <SelectTrigger className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="none">{props.noKey}</SelectItem>
                            {keys.map((k) => (
                                <SelectItem key={k.id} value={String(k.id)}>
                                    {label(k)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
                <Field label="Model" hint={key && !PROVIDER_DEFAULTS[key.provider as Provider]?.model ? "Required for this provider." : undefined}>
                    <ModelPicker
                        name={`${name}Model`}
                        keyId={key ? keyId : ""}
                        provider={key?.provider}
                        defaultModel={key ? PROVIDER_DEFAULTS[key.provider as Provider]?.model : undefined}
                        initial={props.choice.model}
                    />
                </Field>
                <Field label="Reasoning effort" hint="OpenAI / Anthropic.">
                    <Select value={effort} onValueChange={(v) => v && setEffort(v)} disabled={!isAdmin} items={{ default: "Model default", ...Object.fromEntries(EFFORTS.map((x) => [x, x])) }}>
                        <SelectTrigger className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="default">Model default</SelectItem>
                            {EFFORTS.map((x) => (
                                <SelectItem key={x} value={x}>
                                    {x}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </Field>
            </div>
        </section>
    );
}
