import Link from "next/link";
import { redirect } from "next/navigation";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { userCount, validInvite } from "@/lib/auth";
import { getSession } from "@/server/session";
import { SignUpForm } from "./sign-up-form";

export const metadata = { title: "Create account" };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
    if (await getSession()) redirect("/");
    const { invite } = await searchParams;
    const first = (await userCount()) === 0;
    if (!first && !(await validInvite(invite))) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle className="text-xl">Invite needed</CardTitle>
                    <CardDescription>
                        This instance already has an admin. Ask them for an invite link, or{" "}
                        <Link href="/sign-in" className="text-brand underline-offset-4 hover:underline">
                            sign in
                        </Link>
                        .
                    </CardDescription>
                </CardHeader>
            </Card>
        );
    }
    return <SignUpForm first={first} invite={first ? undefined : invite} />;
}
