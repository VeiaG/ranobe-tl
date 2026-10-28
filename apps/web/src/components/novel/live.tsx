"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { NovelStatus } from "@/db/schema";

export interface LiveEvent {
    id: number;
    chapter: number | null;
    level: "info" | "success" | "warning" | "error";
    message: string;
    createdAt: string;
}

interface LiveState {
    status: NovelStatus;
    statusMessage: string;
    current: { index: number; title: string } | null;
    events: LiveEvent[];
    loaded: boolean;
    /** Poll fast for a while, e.g. right after starting a run. */
    kick: () => void;
}

const LiveContext = createContext<LiveState | null>(null);

export function useLive() {
    const ctx = useContext(LiveContext);
    if (!ctx) throw new Error("useLive outside NovelLive");
    return ctx;
}

const ACTIVE: NovelStatus[] = ["running", "waiting"];

/** Polls the novel's live endpoint while a run is active and refreshes server components when the state moves. */
export function NovelLive({ novelId, initialStatus, initialMessage, children }: { novelId: number; initialStatus: NovelStatus; initialMessage: string; children: React.ReactNode }) {
    const router = useRouter();
    const [state, setState] = useState({ status: initialStatus, statusMessage: initialMessage, current: null as LiveState["current"], events: [] as LiveEvent[], loaded: false });
    const lastId = useRef(0);
    const signature = useRef(`${initialStatus}|${initialMessage}`);
    const boostUntil = useRef(0);
    const [tick, setTick] = useState(0);

    const kick = useCallback(() => {
        boostUntil.current = Date.now() + 20_000;
        setTick((t) => t + 1);
    }, []);

    useEffect(() => {
        setState((s) => ({ ...s, status: initialStatus, statusMessage: initialMessage }));
        signature.current = `${initialStatus}|${initialMessage}`;
    }, [initialStatus, initialMessage]);

    useEffect(() => {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout>;
        async function poll() {
            try {
                const res = await fetch(`/api/novels/${novelId}/live?after=${lastId.current}`, { cache: "no-store" });
                if (res.ok) {
                    const data = await res.json();
                    const fresh: LiveEvent[] = data.events ?? [];
                    if (fresh.length) lastId.current = fresh[fresh.length - 1].id;
                    const sig = `${data.status}|${data.statusMessage}|${data.current?.index ?? ""}`;
                    const changed = sig !== signature.current;
                    signature.current = sig;
                    setState((s) => ({
                        status: data.status,
                        statusMessage: data.statusMessage,
                        current: data.current,
                        events: fresh.length ? [...s.events, ...fresh].slice(-300) : s.events,
                        loaded: true,
                    }));
                    if (changed || fresh.some((e) => e.level === "success" || e.level === "error")) router.refresh();
                    if (stopped) return;
                    const active = ACTIVE.includes(data.status) || Date.now() < boostUntil.current;
                    timer = setTimeout(poll, active ? 2500 : 15000);
                    return;
                }
            } catch {
                // offline for a moment, try again later
            }
            if (!stopped) timer = setTimeout(poll, 8000);
        }
        poll();
        return () => {
            stopped = true;
            clearTimeout(timer);
        };
    }, [novelId, router, tick]);

    return <LiveContext.Provider value={{ ...state, kick }}>{children}</LiveContext.Provider>;
}
