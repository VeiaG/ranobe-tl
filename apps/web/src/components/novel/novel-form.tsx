"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
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
import { listModels, type ModelOption } from "@/server/actions/keys";
import { createNovel, updateNovel, type NovelInput } from "@/server/actions/novels";

export interface KeyOption {
    id: number;
    name: string;
    provider: string;
    hint: string;
}

export function Field({ label, hint, htmlFor, children, className }: { label: string; hint?: React.ReactNode; htmlFor?: string; children: React.ReactNode; className?: string }) {
    return (
        // content-start: a hint under the neighbouring field must not push this one's input down
        <div className={cn("grid content-start gap-2", className)}>
            <Label htmlFor={htmlFor}>{label}</Label>
            {children}
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

/** A form section: title and description on the left on wide screens, the fields on the right. */
export function FormSection({ title, description, children }: { title: string; description?: React.ReactNode; children: React.ReactNode }) {
    return (
        <section className="grid gap-5 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:gap-10">
            <div>
                <h2 className="font-medium">{title}</h2>
                {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
            </div>
            <div className="grid min-w-0 content-start gap-5">{children}</div>
        </section>
    );
}

const DEFAULT_MODEL = "__default";
const CUSTOM_MODEL = "__custom";

const perMillion = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, "") : n}`;

/** Model of a novel: the key's provider lists what it has; "Other…" takes any id. Submitted as the `model` field. */
function ModelPicker({ keyId, provider, defaultModel, initial }: { keyId: string; provider?: string; defaultModel?: string; initial: string }) {
    const [value, setValue] = useState(initial);
    const [custom, setCustom] = useState(false);
    // another provider's model id means nothing to this one: back to its default
    const [modelsOf, setModelsOf] = useState(provider);
    if (provider !== modelsOf) {
        setModelsOf(provider);
        setValue("");
        setCustom(false);
    }
    const [models, setModels] = useState<ModelOption[] | null>(null);
    const [error, setError] = useState<string>();

    useEffect(() => {
        if (!keyId) return;
        let live = true;
        setModels(null);
        listModels(Number(keyId)).then((res) => {
            if (!live) return;
            if (!res.ok) return void (setModels([]), setError(res.error));
            setModels(res.data!.models);
            setError(res.data!.error);
        });
        return () => {
            live = false;
        };
    }, [keyId]);

    const list = models ?? [];
    // a saved model the provider no longer lists still shows up
    const options = value && !list.some((m) => m.id === value) ? [{ id: value } as ModelOption, ...list] : list;
    const items: Record<string, string> = {
        ...(defaultModel ? { [DEFAULT_MODEL]: `Default · ${defaultModel}` } : {}),
        ...Object.fromEntries(options.map((m) => [m.id, m.id])),
        [CUSTOM_MODEL]: "Other…",
    };
    const selected = custom ? CUSTOM_MODEL : value || (defaultModel ? DEFAULT_MODEL : CUSTOM_MODEL);

    return (
        <div className="grid gap-2">
            <input type="hidden" name="model" value={value} />
            <Select
                value={selected}
                items={items}
                disabled={!keyId}
                onValueChange={(v) => {
                    if (!v) return;
                    setCustom(v === CUSTOM_MODEL);
                    if (v !== CUSTOM_MODEL) setValue(v === DEFAULT_MODEL ? "" : v);
                }}
            >
                <SelectTrigger className="w-full font-mono text-sm">
                    <SelectValue />
                    {keyId && !models && <Loader2 className="ml-auto animate-spin text-muted-foreground" />}
                </SelectTrigger>
                <SelectContent className="max-h-80">
                    {defaultModel && (
                        <SelectItem value={DEFAULT_MODEL}>
                            Default <span className="font-mono text-muted-foreground">· {defaultModel}</span>
                        </SelectItem>
                    )}
                    {options.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                            <span className="font-mono">{m.id}</span>
                            {m.price && (
                                <span className="ml-auto pl-3 text-xs text-muted-foreground tabular-nums">
                                    {perMillion(m.price.input)} / {perMillion(m.price.output)}
                                </span>
                            )}
                        </SelectItem>
                    ))}
                    <SelectItem value={CUSTOM_MODEL}>Other…</SelectItem>
                </SelectContent>
            </Select>
            {(custom || (!value && !defaultModel)) && (
                <Input aria-label="Model id" value={value} onChange={(e) => setValue(e.target.value)} placeholder="model id" className="font-mono text-sm" autoFocus={custom} />
            )}
            {error && <p className="text-xs text-muted-foreground">Showing the models with a known price: {error}.</p>}
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

type GlossaryStart = { kind: "empty" } | { kind: "novel"; id: string } | { kind: "file"; file: File | null };

/** Where a new novel's glossary starts: empty, a copy of an earlier part, or a glossary file. */
function GlossaryStartPicker({ value, onChange, novels }: { value: GlossaryStart; onChange: (v: GlossaryStart) => void; novels: { id: number; title: string; terms: number }[] }) {
    const options: { kind: GlossaryStart["kind"]; title: string; text: string; disabled?: boolean }[] = [
        { kind: "empty", title: "Start empty", text: "It fills up while the chapters are translated." },
        { kind: "novel", title: "Copy from a novel", text: "An earlier part or a related story in this app.", disabled: !novels.length },
        { kind: "file", title: "From a file", text: "glossary.json, the CLI's meta.json or glossary.db." },
    ];
    return (
        <div className="grid gap-3">
            <div className="grid gap-3 sm:grid-cols-3">
                {options.map((o) => (
                    <button
                        type="button"
                        key={o.kind}
                        disabled={o.disabled}
                        onClick={() => onChange(o.kind === "empty" ? { kind: "empty" } : o.kind === "novel" ? { kind: "novel", id: novels[0] ? String(novels[0].id) : "" } : { kind: "file", file: null })}
                        className={cn(
                            "rounded-lg border p-3 text-left transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-45",
                            value.kind === o.kind && "border-brand/60 bg-brand/5 ring-1 ring-brand/30"
                        )}
                    >
                        <span className="block text-sm font-medium">{o.title}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">{o.text}</span>
                    </button>
                ))}
            </div>
            {value.kind === "novel" && (
                <Select
                    value={value.id}
                    onValueChange={(v) => v && onChange({ kind: "novel", id: v })}
                    items={Object.fromEntries(novels.map((n) => [String(n.id), `${n.title} · ${n.terms} terms`]))}
                >
                    <SelectTrigger className="w-full">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {novels.map((n) => (
                            <SelectItem key={n.id} value={String(n.id)}>
                                {n.title} <span className="text-muted-foreground">· {n.terms} terms</span>
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            )}
            {value.kind === "file" && <Input type="file" accept=".json,.db,.sqlite,application/json" onChange={(e) => onChange({ kind: "file", file: e.target.files?.[0] ?? null })} />}
            {value.kind !== "empty" && (
                <p className="text-xs text-muted-foreground">
                    Terms, translations, locks and notes come along; the last known gender holds from chapter 1, and proposals you rejected or sources marked
                    “not a term” are not asked about again. It is a copy: later changes in one novel do not touch the other.
                </p>
            )}
        </div>
    );
}

export function NovelForm({
    keys,
    initial,
    novelId,
    novels = [],
}: {
    keys: KeyOption[];
    initial?: Partial<NovelInput>;
    novelId?: number;
    /** Other novels whose glossary a new one can start from. */
    novels?: { id: number; title: string; terms: number }[];
}) {
    const router = useRouter();
    const [pending, start] = useTransition();
    const [glossaryStart, setGlossaryStart] = useState<GlossaryStart>({ kind: "empty" });
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
            model: String(f.get("model") ?? "").trim(),
            decisionMode: mode,
            askNew,
            budgetUsd: String(f.get("budgetUsd") ?? "").trim() ? Number(f.get("budgetUsd")) : null,
        };
        if (novelId) {
            start(async () => {
                const res = await updateNovel(novelId, input);
                if (!res.ok) toast.error(res.error);
                else toast.success("Saved");
            });
            return;
        }
        if (glossaryStart.kind === "file" && !glossaryStart.file) return void toast.error("Choose the glossary file");
        start(async () => {
            const res = await createNovel({ ...input, glossaryFrom: glossaryStart.kind === "novel" && glossaryStart.id ? Number(glossaryStart.id) : null });
            if (!res.ok) return void toast.error(res.error);
            const id = res.data!;
            if (glossaryStart.kind === "file" && glossaryStart.file) {
                const form = new FormData();
                form.set("file", glossaryStart.file);
                form.set("sequel", "1");
                const r = await fetch(`/api/novels/${id}/glossary`, { method: "POST", body: form });
                const data = await r.json();
                if (!r.ok) toast.error(`The novel was created, but the glossary was not imported: ${data.error}`);
                else toast.success(data.message);
            }
            router.push(`/novels/${id}/chapters?upload=1`);
            router.refresh();
        });
    }

    return (
        <form onSubmit={onSubmit} className="grid gap-8">
            <FormSection title="The novel" description="Title and synopsis are given to the model as background.">
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
            </FormSection>

            <FormSection title="Model" description="Which key pays for this novel and which model translates it. Prices are per million input / output tokens.">
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
                    <Field label="Model" hint={!defaultModel && key ? "Required for this provider." : undefined}>
                        <ModelPicker keyId={keyId} provider={key?.provider} defaultModel={defaultModel} initial={initial?.model ?? ""} />
                    </Field>
                    <Field label="Budget, USD" htmlFor="budgetUsd" hint="Total for this novel; the run pauses when it is spent. Empty: no cap.">
                        <Input id="budgetUsd" name="budgetUsd" type="number" min={0} step="any" defaultValue={initial?.budgetUsd ?? ""} placeholder="no cap" />
                    </Field>
                </div>
            </FormSection>

            {!novelId && (
                <FormSection title="Glossary" description="A sequel or a second part keeps its names consistent by starting from the earlier part's glossary.">
                    <GlossaryStartPicker value={glossaryStart} onChange={setGlossaryStart} novels={novels} />
                </FormSection>
            )}

            <FormSection
                title="Glossary decisions"
                description="The model may propose changing a translation or a gender that is already in the glossary. How should the run treat that (and new terms, if you review them)?"
            >
                <DecisionModePicker value={mode} onChange={setMode} />
                <AskNewPicker value={askNew} onChange={setAskNew} />
            </FormSection>

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
