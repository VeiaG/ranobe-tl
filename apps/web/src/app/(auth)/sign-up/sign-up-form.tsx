"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function SignUpForm({ first, invite }: { first: boolean; invite?: string }) {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        setPending(true);
        setError(null);
        const { error } = await authClient.signUp.email(
            {
                name: String(form.get("name")),
                email: String(form.get("email")),
                password: String(form.get("password")),
            },
            { headers: invite ? { "x-invite-token": invite } : undefined }
        );
        setPending(false);
        if (error) return setError(error.message ?? "Could not create the account");
        router.replace("/");
        router.refresh();
    }

    return (
        <Card>
            <CardHeader>
                {first && (
                    <div className="mb-2 flex size-9 items-center justify-center rounded-lg bg-brand/12 text-brand">
                        <ShieldCheck className="size-5" />
                    </div>
                )}
                <CardTitle className="text-xl">{first ? "Set up your instance" : "Create your account"}</CardTitle>
                <CardDescription>
                    {first
                        ? "This is the first account, it becomes the admin. Others join with invite links you create."
                        : "You were invited to this translation workspace."}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <form onSubmit={onSubmit} className="grid gap-4">
                    <div className="grid gap-2">
                        <Label htmlFor="name">Name</Label>
                        <Input id="name" name="name" autoComplete="name" required autoFocus />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="email">Email</Label>
                        <Input id="email" name="email" type="email" autoComplete="email" required />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="password">Password</Label>
                        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
                        <p className="text-xs text-muted-foreground">At least 8 characters.</p>
                    </div>
                    {error && <p className="text-sm text-destructive">{error}</p>}
                    <Button type="submit" disabled={pending} className="mt-1">
                        {pending && <Loader2 className="animate-spin" />}
                        {first ? "Create admin account" : "Create account"}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
