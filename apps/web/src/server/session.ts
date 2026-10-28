import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/lib/auth";

export const getSession = cache(async () => auth.api.getSession({ headers: await headers() }));

/** The signed-in user or a redirect to the sign-in page. */
export async function requireUser() {
    const session = await getSession();
    if (!session) redirect("/sign-in");
    return session.user as typeof session.user & { role: string };
}

export async function requireAdmin() {
    const user = await requireUser();
    if (user.role !== "admin") throw new Error("Only the admin can do this");
    return user;
}
