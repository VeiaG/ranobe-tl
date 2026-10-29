"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Link2, Loader2, Shield, Trash2, UserPlus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/utils";
import { createInvite, removeUser, revokeInvite } from "@/server/actions/users";

export function UsersPanel({ meId, users, invites }: { meId: string; users: { id: string; name: string; email: string; role: string; createdAt: string }[]; invites: { token: string; note: string; expiresAt: string }[] }) {
    const router = useRouter();
    const [note, setNote] = useState("");
    const [pending, start] = useTransition();
    const inviteUrl = (token: string) => `${window.location.origin}/sign-up?invite=${token}`;

    return (
        <div className="grid gap-6">
            <div className="rounded-xl border bg-card shadow-xs">
                <div className="border-b px-5 py-3 text-sm font-medium">People</div>
                <ul className="divide-y">
                    {users.map((u) => (
                        <li key={u.id} className="flex items-center gap-3 px-5 py-3">
                            <span className="flex size-8 items-center justify-center rounded-md bg-brand/12 text-xs font-semibold text-brand">
                                {u.name.slice(0, 2).toUpperCase()}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 text-sm font-medium">
                                    {u.name}
                                    {u.id === meId && <span className="text-xs font-normal text-muted-foreground">you</span>}
                                </div>
                                <div className="truncate text-xs text-muted-foreground">
                                    {u.email} · joined {timeAgo(u.createdAt)}
                                </div>
                            </div>
                            {u.role === "admin" ? (
                                <Badge variant="brand">
                                    <Shield />
                                    Admin
                                </Badge>
                            ) : (
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="Remove user"
                                    onClick={() =>
                                        start(async () => {
                                            if (!confirm(`Remove ${u.name}? Their novels stay.`)) return;
                                            const res = await removeUser(u.id);
                                            if (!res.ok) toast.error(res.error);
                                            router.refresh();
                                        })
                                    }
                                >
                                    <Trash2 />
                                </Button>
                            )}
                        </li>
                    ))}
                </ul>
            </div>

            <div className="rounded-xl border bg-card shadow-xs">
                <div className="border-b px-5 py-3">
                    <div className="text-sm font-medium">Invite someone</div>
                    <div className="text-xs text-muted-foreground">Everyone on this instance sees all novels. Links work once and expire in 7 days.</div>
                </div>
                <form
                    className="flex gap-2 px-5 py-4"
                    onSubmit={(e) => {
                        e.preventDefault();
                        start(async () => {
                            const res = await createInvite(note);
                            if (!res.ok) return void toast.error(res.error);
                            await navigator.clipboard.writeText(inviteUrl(res.data!)).catch(() => {});
                            toast.success("Invite link created and copied");
                            setNote("");
                            router.refresh();
                        });
                    }}
                >
                    <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Who is it for? (optional)" />
                    <Button type="submit" disabled={pending}>
                        {pending ? <Loader2 className="animate-spin" /> : <UserPlus />}
                        Create link
                    </Button>
                </form>
                {invites.length > 0 && (
                    <ul className="divide-y border-t">
                        {invites.map((i) => (
                            <li key={i.token} className="flex items-center gap-3 px-5 py-3">
                                <Link2 className="size-4 text-muted-foreground" />
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm">{i.note || "Invite"}</div>
                                    <div className="truncate font-mono text-xs text-muted-foreground">…/sign-up?invite={i.token.slice(0, 8)}… · expires {new Date(i.expiresAt).toLocaleDateString()}</div>
                                </div>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => {
                                        navigator.clipboard.writeText(inviteUrl(i.token));
                                        toast.success("Copied");
                                    }}
                                >
                                    <Copy />
                                    Copy
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="Revoke"
                                    onClick={() =>
                                        start(async () => {
                                            await revokeInvite(i.token);
                                            router.refresh();
                                        })
                                    }
                                >
                                    <Trash2 />
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}
