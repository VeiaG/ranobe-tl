import { redirect } from "next/navigation";
import { userCount } from "@/lib/auth";
import { getSession } from "@/server/session";
import { SignInForm } from "./sign-in-form";

export const metadata = { title: "Sign in" };

export default async function SignInPage() {
    if (await getSession()) redirect("/");
    if ((await userCount()) === 0) redirect("/sign-up");
    return <SignInForm />;
}
