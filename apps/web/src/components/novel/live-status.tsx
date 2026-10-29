"use client";

import { NovelStatusBadge } from "@/components/status";
import { useLive } from "./live";

export function LiveStatus() {
    const { status, statusMessage } = useLive();
    return (
        <div className="flex min-w-0 items-center gap-2">
            <NovelStatusBadge status={status} />
            {statusMessage && <span className="truncate text-sm text-muted-foreground">{statusMessage}</span>}
        </div>
    );
}
