"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function NovelTabs({ novelId, counts }: { novelId: number; counts: { chapters: number; terms: number; pending: number } }) {
    const pathname = usePathname();
    const base = `/novels/${novelId}`;
    const tabs = [
        { href: base, label: "Overview", exact: true },
        { href: `${base}/chapters`, label: "Chapters", count: counts.chapters },
        { href: `${base}/glossary`, label: "Glossary", count: counts.terms },
        { href: `${base}/decisions`, label: "Decisions", count: counts.pending, highlight: counts.pending > 0 },
        { href: `${base}/replace`, label: "Replace" },
        { href: `${base}/settings`, label: "Settings" },
    ];
    return (
        <nav className="scrollbar-thin -mb-px flex gap-1 overflow-x-auto">
            {tabs.map((t) => {
                const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
                return (
                    <Link
                        key={t.href}
                        href={t.href}
                        className={cn(
                            "flex shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 pt-1 pb-2.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                            active && "border-foreground font-medium text-foreground"
                        )}
                    >
                        {t.label}
                        {t.count !== undefined && t.count > 0 && (
                            <span
                                className={cn(
                                    "rounded-full bg-muted px-1.5 py-px text-[11px] tabular-nums text-muted-foreground",
                                    t.highlight && "bg-warning/20 font-semibold text-[color-mix(in_oklch,var(--warning)_75%,var(--foreground))]"
                                )}
                            >
                                {t.count}
                            </span>
                        )}
                    </Link>
                );
            })}
        </nav>
    );
}
