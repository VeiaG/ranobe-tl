"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useLive, type LiveEvent } from "./live";

const ICON: Record<LiveEvent["level"], { icon: React.ComponentType<{ className?: string }>; className: string }> = {
    info: { icon: Info, className: "text-muted-foreground" },
    success: { icon: CircleCheck, className: "text-success" },
    warning: { icon: TriangleAlert, className: "text-warning" },
    error: { icon: CircleAlert, className: "text-destructive" },
};

function time(iso: string) {
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    return d.toLocaleString("en-GB", today ? { hour: "2-digit", minute: "2-digit", second: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function ActivityFeed({ novelId, className }: { novelId: number; className?: string }) {
    const { events, loaded, current } = useLive();
    const box = useRef<HTMLDivElement>(null);
    const stick = useRef(true);

    useEffect(() => {
        const el = box.current;
        if (el && stick.current) el.scrollTop = el.scrollHeight;
    }, [events.length]);

    return (
        <div className={cn("flex flex-col overflow-hidden rounded-xl border bg-card shadow-xs", className)}>
            <div className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-sm font-medium">Activity</h2>
                {current && (
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="relative flex size-2">
                            <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />
                            <span className="relative inline-flex size-2 rounded-full bg-brand" />
                        </span>
                        chapter {current.index}
                    </span>
                )}
            </div>
            <div
                ref={box}
                onScroll={(e) => {
                    const el = e.currentTarget;
                    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                }}
                className="scrollbar-thin h-[26rem] overflow-y-auto px-2 py-2 font-mono text-[12.5px] leading-relaxed"
            >
                {!loaded &&
                    Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="mx-2 my-2 h-4" style={{ width: `${55 + ((i * 17) % 40)}%` }} />)}
                {loaded && events.length === 0 && <p className="px-2 py-6 text-center font-sans text-sm text-muted-foreground">Nothing has happened yet.</p>}
                {events.map((e) => {
                    const { icon: Icon, className } = ICON[e.level];
                    return (
                        <div key={e.id} className="group flex gap-2.5 rounded-md px-2 py-1 hover:bg-muted/60">
                            <span className="w-[4.5rem] shrink-0 text-muted-foreground/70 tabular-nums">{time(e.createdAt)}</span>
                            <Icon className={cn("mt-[3px] size-3.5 shrink-0", className)} />
                            <span className="min-w-0 flex-1 break-words">
                                {e.chapter !== null && (
                                    <Link href={`/novels/${novelId}/chapters/${e.chapter}`} className="mr-1.5 rounded bg-muted px-1 text-muted-foreground hover:text-foreground">
                                        #{e.chapter}
                                    </Link>
                                )}
                                <span className={cn(e.level === "error" && "text-destructive")}>{e.message}</span>
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
