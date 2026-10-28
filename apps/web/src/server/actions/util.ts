import "server-only";

export type ActionResult<T = undefined> = { ok: true; data?: T; message?: string } | { ok: false; error: string };

/** Runs an action body and turns thrown errors into a result the client can show. */
export async function action<T>(fn: () => Promise<T | ActionResult<T>>): Promise<ActionResult<T>> {
    try {
        const out = await fn();
        if (out && typeof out === "object" && "ok" in out) return out as ActionResult<T>;
        return { ok: true, data: out as T };
    } catch (error) {
        // redirect() and notFound() work by throwing; let Next handle them
        if (error && typeof error === "object" && "digest" in error && String((error as any).digest).startsWith("NEXT_")) throw error;
        console.error(error);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
}
