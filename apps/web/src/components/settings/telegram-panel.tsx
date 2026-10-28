"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
import { Bell, CheckCircle2, Copy, ExternalLink, Loader2, Send, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { timeAgo } from "@/lib/utils";
import { saveTelegramToken } from "@/server/actions/instance";
import { createTelegramLink, setTelegramNotifications, unlinkTelegram } from "@/server/actions/users";

interface Link {
    linked: boolean;
    username: string | null;
    token: string | null;
    notifyDecisions: boolean;
    notifyFailures: boolean;
    notifyFinished: boolean;
    linkedAt: string | null;
}

/** Where an admin sets or replaces the bot token, instead of TELEGRAM_BOT_TOKEN in .env. */
function TokenForm({ source }: { source: "ui" | "env" | null }) {
    const router = useRouter();
    const [token, setToken] = useState("");
    const [pending, start] = useTransition();
    const save = (value: string) =>
        start(async () => {
            const res = await saveTelegramToken(value);
            if (!res.ok) return void toast.error(res.error);
            toast.success(res.message ?? "Saved");
            setToken("");
            router.refresh();
        });
    return (
        <form
            className="grid gap-2"
            onSubmit={(e) => {
                e.preventDefault();
                save(token);
            }}
        >
            <div className="flex gap-2">
                <Input
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    type="password"
                    autoComplete="off"
                    placeholder={source ? "New token to replace the current one" : "123456789:AA…"}
                    className="font-mono text-sm"
                />
                <Button type="submit" disabled={pending || !token.trim()}>
                    {pending && <Loader2 className="animate-spin" />}
                    Save token
                </Button>
                {source === "ui" && (
                    <Button type="button" variant="ghost" disabled={pending} onClick={() => save("")}>
                        Remove
                    </Button>
                )}
            </div>
            <p className="text-xs text-muted-foreground">
                {source === "ui"
                    ? "The bot uses the token saved here (encrypted with APP_SECRET)."
                    : source === "env"
                      ? "The bot uses TELEGRAM_BOT_TOKEN from the environment; a token saved here takes over."
                      : "Stored encrypted with APP_SECRET. The worker starts the bot within half a minute, no restart needed."}
            </p>
        </form>
    );
}

export function TelegramPanel({
    configured,
    bot,
    link,
    tokenSource,
    isAdmin,
}: {
    configured: boolean;
    bot: string | null;
    link: Link | null;
    tokenSource: "ui" | "env" | null;
    isAdmin: boolean;
}) {
    const router = useRouter();
    const [pending, start] = useTransition();

    // while a link token is shown, check every few seconds whether the bot got /start
    useEffect(() => {
        if (!link?.token || link.linked) return;
        const t = setInterval(() => router.refresh(), 4000);
        return () => clearInterval(t);
    }, [link?.token, link?.linked, router]);

    if (!configured) {
        return (
            <div className="rounded-xl border bg-card p-6 shadow-xs">
                <div className="flex items-start gap-4">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-info/12 text-info">
                        <Send className="size-5" />
                    </div>
                    <div className="space-y-3 text-sm">
                        <div>
                            <h2 className="font-medium">Telegram is not set up on this instance</h2>
                            <p className="mt-1 text-muted-foreground">Get decisions with buttons, failures and finished runs in Telegram. The bot uses long polling, so it works without a public address.</p>
                        </div>
                        <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
                            <li>
                                Create a bot with <span className="font-medium text-foreground">@BotFather</span> and copy its token.
                            </li>
                            <li>{isAdmin ? "Paste it below." : "Ask the admin to add it here."}</li>
                            <li>Link your chat with the button that appears.</li>
                        </ol>
                        {isAdmin && <TokenForm source={tokenSource} />}
                    </div>
                </div>
            </div>
        );
    }

    const startLink = bot && link?.token ? `https://t.me/${bot}?start=${link.token}` : null;
    const toggle = (key: "notifyDecisions" | "notifyFailures" | "notifyFinished", value: boolean) =>
        start(async () => {
            const res = await setTelegramNotifications({ [key]: value });
            if (!res.ok) toast.error(res.error);
            router.refresh();
        });

    return (
        <div className="grid gap-4">
            <div className="rounded-xl border bg-card p-6 shadow-xs">
                {link?.linked ? (
                    <div className="flex flex-wrap items-center gap-4">
                        <div className="flex size-10 items-center justify-center rounded-xl bg-success/12 text-success">
                            <CheckCircle2 className="size-5" />
                        </div>
                        <div className="flex-1 text-sm">
                            <div className="font-medium">Linked{link.username ? ` to @${link.username}` : ""}</div>
                            <div className="text-muted-foreground">
                                since {timeAgo(link.linkedAt)}. In the chat: /pending, /status{bot ? ` · @${bot}` : ""}.
                            </div>
                        </div>
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={pending}
                            onClick={() =>
                                start(async () => {
                                    await unlinkTelegram();
                                    router.refresh();
                                })
                            }
                        >
                            <Unlink />
                            Unlink
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-info/12 text-info">
                            <Send className="size-5" />
                        </div>
                        <div className="flex-1 text-sm">
                            <div className="font-medium">Link your Telegram</div>
                            {link?.token ? (
                                <div className="text-muted-foreground">
                                    {startLink ? "Open the link and press Start. This page updates by itself." : <>Send <code className="rounded bg-muted px-1 text-foreground">/start {link.token}</code> to the bot.</>}
                                </div>
                            ) : (
                                <div className="text-muted-foreground">Creates a one-time link for the bot.</div>
                            )}
                        </div>
                        {link?.token && startLink ? (
                            <div className="flex gap-2">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                        navigator.clipboard.writeText(startLink);
                                        toast.success("Copied");
                                    }}
                                >
                                    <Copy />
                                    Copy
                                </Button>
                                <Button size="sm" nativeButton={false} render={<a href={startLink} target="_blank" rel="noreferrer" />}>
                                        <ExternalLink />
                                        Open Telegram
                                    </Button>
                            </div>
                        ) : (
                            <Button
                                disabled={pending}
                                onClick={() =>
                                    start(async () => {
                                        const res = await createTelegramLink();
                                        if (!res.ok) toast.error(res.error);
                                        router.refresh();
                                    })
                                }
                            >
                                {pending ? <Loader2 className="animate-spin" /> : <Send />}
                                {link?.token ? "New link" : "Create link"}
                            </Button>
                        )}
                    </div>
                )}
            </div>
            {isAdmin && (
                <details className="rounded-xl border bg-card px-5 py-3 text-sm shadow-xs">
                    <summary className="cursor-pointer text-muted-foreground">Bot token{bot ? ` · @${bot}` : ""}</summary>
                    <div className="mt-3">
                        <TokenForm source={tokenSource} />
                    </div>
                </details>
            )}
            {link?.linked && (
                <div className="rounded-xl border bg-card shadow-xs">
                    <div className="flex items-center gap-2 border-b px-5 py-3 text-sm font-medium">
                        <Bell className="size-4 text-muted-foreground" />
                        Notify me about
                    </div>
                    {(
                        [
                            ["notifyDecisions", "Glossary decisions", "With buttons to answer right in the chat."],
                            ["notifyFailures", "Failures", "A chapter failed, or a run stopped by itself."],
                            ["notifyFinished", "Finished runs", "When a novel has nothing left in its queue."],
                        ] as const
                    ).map(([key, title, text]) => (
                        <label key={key} className="flex items-center justify-between gap-4 border-b px-5 py-3.5 last:border-0">
                            <span>
                                <span className="block text-sm font-medium">{title}</span>
                                <span className="block text-xs text-muted-foreground">{text}</span>
                            </span>
                            <Switch checked={link[key]} onCheckedChange={(v) => toggle(key, v)} />
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
}
