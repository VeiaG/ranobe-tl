import { NextResponse } from "next/server";
import { db } from "@/db";
import { getSession } from "@/server/session";
import { filesFromZip, importNovelFolder } from "@/server/storage/import";

export const runtime = "nodejs";

/** Creates a novel from a zipped folder (this app's backup layout or a CLI novel folder). */
export async function POST(req: Request) {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) return NextResponse.json({ error: "Choose a .zip file" }, { status: 400 });
    try {
        const files = await filesFromZip(await file.arrayBuffer());
        const keyId = Number(form.get("providerKeyId"));
        const res = await importNovelFolder(db, files, {
            title: String(form.get("title") ?? ""),
            providerKeyId: Number.isInteger(keyId) && keyId > 0 ? keyId : null,
            createdBy: session.user.id,
            fallbackTitle: file.name.replace(/\.zip$/i, ""),
        });
        return NextResponse.json(res);
    } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
}
