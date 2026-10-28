import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Secret for API keys at rest; the same APP_SECRET signs sessions. */
function key(): Buffer {
    const secret = process.env.APP_SECRET ?? process.env.BETTER_AUTH_SECRET;
    if (!secret || secret.length < 16) throw new Error("APP_SECRET must be set (at least 16 characters)");
    return createHash("sha256").update(`ranobe-tl:keys:${secret}`).digest();
}

export function encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key(), iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export function decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(".");
    if (version !== "v1" || !iv || !tag || !data) throw new Error("unknown key format");
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 18): string {
    return randomBytes(bytes).toString("base64url");
}
