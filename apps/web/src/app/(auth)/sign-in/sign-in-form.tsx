"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function SignInForm() {
    const router = useRouter();
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        setPending(true);
        setError(null);
        const { error } = await authClient.signIn.email({
            email: String(form.get("email")),
            password: String(form.get("password")),
            rememberMe: true,
        });
        setPending(false);
        if (error) return setError(error.message ?? "Could not sign in");
        router.replace("/");
        router.refresh();
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-xl">Welcome back</CardTitle>
                <CardDescription>Sign in to your translation workspace.</CardDescription>
            </CardHeader>
            <CardContent>
                <form onSubmit={onSubmit} className="grid gap-4">
                    <div className="grid gap-2">
                        <Label htmlFor="email">Email</Label>
                        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
                    </div>
                    <div className="grid gap-2">
                        <Label htmlFor="password">Password</Label>
                        <Input id="password" name="password" type="password" autoComplete="current-password" required />
                    </div>
                    {error && <p className="text-sm text-destructive">{error}</p>}
                    <Button type="submit" disabled={pending} className="mt-1">
                        {pending && <Loader2 className="animate-spin" />}
                        Sign in
                    </Button>
                    <p className="text-center text-xs text-muted-foreground">No account? Ask the admin of this instance for an invite link.</p>
                </form>
            </CardContent>
        </Card>
    );
}
