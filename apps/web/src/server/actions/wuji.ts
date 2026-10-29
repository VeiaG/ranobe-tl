"use server";

import { z } from "zod";
import { requireUser } from "@/server/session";
import { cleanToken, wujiBooks, wujiLogin, wujiMe } from "@/server/wuji";
import { action } from "./util";

const SignIn = z.union([z.object({ token: z.string().trim().min(1, "Paste the token") }), z.object({ email: z.string().trim().min(1, "Enter the email"), password: z.string().min(1, "Enter the password") })]);

/** Signs in to wuji.world; the token goes back to the dialog only and is never stored. */
export async function wujiSignIn(input: z.input<typeof SignIn>) {
    return action(async () => {
        await requireUser();
        const data = SignIn.parse(input);
        const token = "token" in data ? cleanToken(data.token) : await wujiLogin(data.email, data.password);
        const user = await wujiMe(token);
        return { token, name: user.nickname || user.email };
    });
}

export async function wujiSearchBooks(token: string, q: string) {
    return action(async () => {
        await requireUser();
        return wujiBooks(token, q);
    });
}
