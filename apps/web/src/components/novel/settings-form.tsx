"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, Loader2 } from "lucide-react";
import { EFFORTS } from "@ranobe-tl/core";
import { Field } from "@/components/novel/novel-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { updateNovelSettings } from "@/server/actions/novels";
import type { NovelSettings } from "@/server/novel-config";

interface Defaults {
    maxOutputTokens: number;
    chunkSize: number;
    contextChars: number;
    maxAttempts: number;
    patternsToRemove: string[];
    validation: { minSourceChars: number; minRatio: number; maxRatio: number; maxLatinPercent: number; maxRepeatSpan: number; maxParagraphLoss: number };
}

const lines = (s: FormDataEntryValue | null) =>
    String(s ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

const num = (s: FormDataEntryValue | null) => {
    const v = String(s ?? "").trim();
    return v === "" ? undefined : Number(v);
};

export function SettingsForm({ novelId, settings, defaults }: { novelId: number; settings: NovelSettings; defaults: Defaults }) {
    const [pending, start] = useTransition();
    const [effort, setEffort] = useState<string>(settings.effort ?? "default");
    const [advanced, setAdvanced] = useState(false);
    const v = settings.validation ?? {};

    function onSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const fixedTerms: Record<string, string> = {};
        for (const line of lines(f.get("fixedTerms"))) {
            const [source, ...rest] = line.split(/\s*(?:=|→|->)\s*/);
            if (source && rest.length) fixedTerms[source] = rest.join(" ");
        }
        const validation = Object.fromEntries(
            Object.entries({
                minSourceChars: num(f.get("minSourceChars")),
                minRatio: num(f.get("minRatio")),
                maxRatio: num(f.get("maxRatio")),
                maxLatinPercent: num(f.get("maxLatinPercent")),
                maxRepeatSpan: num(f.get("maxRepeatSpan")),
                maxParagraphLoss: num(f.get("maxParagraphLoss")),
            }).filter(([, x]) => x !== undefined)
        );
        const patterns = lines(f.get("patternsToRemove"));
        const next: NovelSettings = {
            effort: effort === "default" ? undefined : (effort as NovelSettings["effort"]),
            temperature: num(f.get("temperature")),
            maxOutputTokens: num(f.get("maxOutputTokens")),
            chunkSize: num(f.get("chunkSize")),
            contextChars: num(f.get("contextChars")),
            maxAttempts: num(f.get("maxAttempts")),
            instructions: String(f.get("instructions") ?? "").trim() || undefined,
            fixedTerms: Object.keys(fixedTerms).length ? fixedTerms : undefined,
            stringsToRemove: lines(f.get("stringsToRemove")).length ? lines(f.get("stringsToRemove")) : undefined,
            patternsToRemove: patterns.length ? patterns : undefined,
            validation: Object.keys(validation).length ? validation : undefined,
        };
        start(async () => {
            const res = await updateNovelSettings(novelId, next);
            if (!res.ok) toast.error(res.error);
            else toast.success(res.message ?? "Saved");
        });
    }

    return (
        <form onSubmit={onSubmit} className="grid gap-8">
            <section className="grid gap-5">
                <div>
                    <h2 className="font-medium">Translation</h2>
                    <p className="text-sm text-muted-foreground">How the model is asked. Changes apply from the next chapter.</p>
                </div>
                <Field label="Extra instructions" htmlFor="instructions" hint="Appended to the system prompt: style, honorifics, how to treat system messages in brackets…">
                    <Textarea id="instructions" name="instructions" defaultValue={settings.instructions} rows={4} className="min-h-24" placeholder="Keep Korean honorifics like -nim. Status windows in [brackets] stay in brackets." />
                </Field>
                <Field label="Fixed terms" htmlFor="fixedTerms" hint="One per line, “source = translation”. Sent with every chunk and never changed.">
                    <Textarea id="fixedTerms" name="fixedTerms" defaultValue={Object.entries(settings.fixedTerms ?? {}).map(([k, x]) => `${k} = ${x}`).join("\n")} rows={3} className="font-mono text-xs" />
                </Field>
                <div className="grid gap-5 sm:grid-cols-3">
                    <Field label="Reasoning effort" hint="OpenAI / Anthropic. Translation rarely needs much.">
                        <Select value={effort} onValueChange={(v) => v && setEffort(v)} items={{ default: "Model default", ...Object.fromEntries(EFFORTS.map((x) => [x, x])) }}>
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
                    <Field label="Temperature" htmlFor="temperature" hint="Leave empty for current Claude models.">
                        <Input id="temperature" name="temperature" type="number" step="0.05" min={0} max={2} defaultValue={settings.temperature} placeholder="default" />
                    </Field>
                    <Field label="Attempts per chunk" htmlFor="maxAttempts">
                        <Input id="maxAttempts" name="maxAttempts" type="number" min={1} max={10} defaultValue={settings.maxAttempts} placeholder={String(defaults.maxAttempts)} />
                    </Field>
                </div>
            </section>

            <section className="grid gap-5">
                <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex items-center justify-between text-left">
                    <span>
                        <span className="block font-medium">Chunks, cleanup and validation</span>
                        <span className="block text-sm text-muted-foreground">Defaults work for most novels.</span>
                    </span>
                    <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", advanced && "rotate-180")} />
                </button>
                <div className={cn("grid gap-5", !advanced && "hidden")}>
                    <div className="grid gap-5 sm:grid-cols-3">
                        <Field label="Chunk size" htmlFor="chunkSize" hint="Characters per request. Long chunks make models summarize.">
                            <Input id="chunkSize" name="chunkSize" type="number" min={1000} defaultValue={settings.chunkSize} placeholder={String(defaults.chunkSize)} />
                        </Field>
                        <Field label="Context" htmlFor="contextChars" hint="Characters of the previous part sent along.">
                            <Input id="contextChars" name="contextChars" type="number" min={0} defaultValue={settings.contextChars} placeholder={String(defaults.contextChars)} />
                        </Field>
                        <Field label="Max output tokens" htmlFor="maxOutputTokens">
                            <Input id="maxOutputTokens" name="maxOutputTokens" type="number" min={1000} defaultValue={settings.maxOutputTokens} placeholder={String(defaults.maxOutputTokens)} />
                        </Field>
                    </div>
                    <div className="grid gap-5 sm:grid-cols-2">
                        <Field label="Strings to remove" htmlFor="stringsToRemove" hint="Exact text cut from sources, one per line.">
                            <Textarea id="stringsToRemove" name="stringsToRemove" defaultValue={(settings.stringsToRemove ?? []).join("\n")} rows={3} className="font-mono text-xs" />
                        </Field>
                        <Field label="Patterns to remove" htmlFor="patternsToRemove" hint="Regexes (multiline, case-insensitive). Replaces the default credit-line pattern.">
                            <Textarea id="patternsToRemove" name="patternsToRemove" defaultValue={(settings.patternsToRemove ?? []).join("\n")} placeholder={defaults.patternsToRemove.join("\n")} rows={3} className="font-mono text-xs" />
                        </Field>
                    </div>
                    <div>
                        <div className="mb-3 text-sm font-medium">Validation</div>
                        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                            {(
                                [
                                    ["minRatio", "Min length ratio", "0.05"],
                                    ["maxRatio", "Max length ratio", "0.05"],
                                    ["maxLatinPercent", "Max Latin, %", "0.5"],
                                    ["maxParagraphLoss", "Max paragraph loss", "0.01"],
                                    ["maxRepeatSpan", "Max repeated span", "10"],
                                    ["minSourceChars", "Skip sources under", "100"],
                                ] as const
                            ).map(([key, label, step]) => (
                                <Field key={key} label={label} htmlFor={key}>
                                    <Input id={key} name={key} type="number" step={step} defaultValue={v[key]} placeholder={String(defaults.validation[key])} />
                                </Field>
                            ))}
                        </div>
                        <p className="mt-3 text-xs text-muted-foreground">For a Latin-script target language set “Max Latin” to 100.</p>
                    </div>
                </div>
            </section>

            <div className="flex justify-end border-t pt-6">
                <Button type="submit" disabled={pending}>
                    {pending && <Loader2 className="animate-spin" />}
                    Save translation settings
                </Button>
            </div>
        </form>
    );
}
