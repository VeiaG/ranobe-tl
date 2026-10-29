"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

interface Options {
    novels: { id: number; title: string }[];
    keys: { id: number; name: string; provider: string }[];
    providers: string[];
    models: string[];
}

const RANGE_LABELS: Record<string, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", all: "All time" };

/** One row above the chart: time range first, then the dimensions. */
export function UsageFiltersBar({ options }: { options: Options }) {
    const router = useRouter();
    const pathname = usePathname();
    const sp = useSearchParams();
    const range = sp.get("range") ?? "30d";
    const set = (key: string, value: string | null) => {
        const next = new URLSearchParams(sp.toString());
        if (!value || value === "all-items") next.delete(key);
        else next.set(key, value);
        router.replace(`${pathname}${next.size ? `?${next}` : ""}`, { scroll: false });
    };
    const any = ["novel", "provider", "model", "key"].some((k) => sp.get(k));

    const filter = (key: string, label: string, items: { value: string; label: string }[]) => (
        <Select value={sp.get(key) ?? "all-items"} onValueChange={(v) => set(key, v)} items={{ "all-items": label, ...Object.fromEntries(items.map((i) => [i.value, i.label])) }}>
            <SelectTrigger size="sm" className={cn("min-w-32", sp.get(key) && "border-brand/50 text-brand")}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectItem value="all-items">{label}</SelectItem>
                {items.map((i) => (
                    <SelectItem key={i.value} value={i.value}>
                        {i.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );

    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-lg bg-muted p-[3px]">
                {Object.entries(RANGE_LABELS).map(([value, label]) => (
                    <button
                        key={value}
                        onClick={() => set("range", value === "30d" ? null : value)}
                        className={cn("rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground", range === value && "bg-background text-foreground shadow-sm dark:bg-input/30")}
                    >
                        {label}
                    </button>
                ))}
            </div>
            {filter("novel", "All novels", options.novels.map((n) => ({ value: String(n.id), label: n.title })))}
            {filter("provider", "All providers", options.providers.map((p) => ({ value: p, label: p })))}
            {filter("model", "All models", options.models.map((m) => ({ value: m, label: m })))}
            {filter("key", "All keys", options.keys.map((k) => ({ value: String(k.id), label: k.name })))}
            {any && (
                <Button variant="ghost" size="sm" onClick={() => router.replace(range === "30d" ? pathname : `${pathname}?range=${range}`, { scroll: false })}>
                    <X />
                    Clear
                </Button>
            )}
        </div>
    );
}
