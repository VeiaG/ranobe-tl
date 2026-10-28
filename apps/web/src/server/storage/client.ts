import { AwsClient } from "aws4fetch";
import type { DB } from "@/db";
import { decrypt } from "@/lib/crypto";
import { getSetting } from "../settings";

/** An S3-compatible bucket for backups: Cloudflare R2, Backblaze B2, MinIO, AWS S3. */
export interface StorageConfig {
    enabled: boolean;
    /** https://<account>.r2.cloudflarestorage.com, https://s3.eu-central-1.amazonaws.com, http://minio:9000 */
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    /** Encrypted with APP_SECRET, like the provider keys. */
    secretEncrypted: string;
    /** Folder inside the bucket that holds one subfolder per novel. */
    prefix: string;
    /** Also upload the source chapters (larger, but the folder is then complete). */
    includeSources: boolean;
}

export const STORAGE_KEY = "storage";

export const STORAGE_DEFAULTS: StorageConfig = {
    enabled: false,
    endpoint: "",
    region: "auto",
    bucket: "",
    accessKeyId: "",
    secretEncrypted: "",
    prefix: "ranobe-tl",
    includeSources: true,
};

export interface StorageStatus {
    lastRunAt: string | null;
    uploaded: number;
    novels: number;
    error: string | null;
}

export const STORAGE_STATUS_KEY = "storage_status";
export const STORAGE_STATUS_DEFAULTS: StorageStatus = { lastRunAt: null, uploaded: 0, novels: 0, error: null };

export class Bucket {
    private aws: AwsClient;
    private base: string;

    constructor(
        private config: Pick<StorageConfig, "endpoint" | "region" | "bucket" | "accessKeyId" | "prefix">,
        secret: string
    ) {
        this.aws = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: secret, region: config.region || "auto", service: "s3" });
        // path-style URLs work on R2, B2, MinIO and AWS alike
        this.base = `${config.endpoint.replace(/\/+$/, "")}/${encodeURIComponent(config.bucket)}`;
    }

    /** Full object key under the configured prefix. */
    key(path: string): string {
        const prefix = this.config.prefix.replace(/^\/+|\/+$/g, "");
        return prefix ? `${prefix}/${path}` : path;
    }

    private url(key: string, query = ""): string {
        return `${this.base}/${key.split("/").map(encodeURIComponent).join("/")}${query}`;
    }

    private async call(method: string, url: string, init: { body?: BodyInit; headers?: Record<string, string> } = {}): Promise<Response> {
        const res = await this.aws.fetch(url, { method, ...init });
        if (!res.ok && !(method === "GET" && res.status === 404)) {
            const text = await res.text().catch(() => "");
            const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
            const message = text.match(/<Message>([^<]+)<\/Message>/)?.[1];
            throw new Error(`storage ${method} failed: ${res.status} ${code ?? ""} ${message ?? text.slice(0, 200)}`.trim());
        }
        return res;
    }

    async put(path: string, body: string | Uint8Array, contentType: string): Promise<void> {
        await this.call("PUT", this.url(this.key(path)), { body: body as BodyInit, headers: { "content-type": contentType } });
    }

    /** null when the object does not exist. */
    async get(path: string): Promise<Uint8Array | null> {
        const res = await this.call("GET", this.url(this.key(path)));
        if (res.status === 404) return null;
        return new Uint8Array(await res.arrayBuffer());
    }

    async delete(path: string): Promise<void> {
        await this.call("DELETE", this.url(this.key(path)));
    }

    /** Object paths (relative to the prefix) and, with a delimiter, the "subfolders". */
    async list(path: string, delimiter?: string): Promise<{ files: { path: string; size: number }[]; folders: string[] }> {
        const files: { path: string; size: number }[] = [];
        const folders: string[] = [];
        const prefix = this.key(path);
        const strip = this.key("");
        let token: string | undefined;
        do {
            const q = new URLSearchParams({ "list-type": "2", prefix, ...(delimiter ? { delimiter } : {}), ...(token ? { "continuation-token": token } : {}) });
            const xml = await (await this.call("GET", `${this.base}/?${q}`)).text();
            for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
                const key = decodeXml(m[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1] ?? "");
                files.push({ path: key.slice(strip.length), size: Number(m[1].match(/<Size>(\d+)<\/Size>/)?.[1] ?? 0) });
            }
            for (const m of xml.matchAll(/<CommonPrefixes>\s*<Prefix>([\s\S]*?)<\/Prefix>\s*<\/CommonPrefixes>/g)) {
                folders.push(decodeXml(m[1]).slice(strip.length));
            }
            token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? decodeXml(xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? "") || undefined : undefined;
        } while (token);
        return { files, folders };
    }
}

function decodeXml(s: string): string {
    return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

export async function storageConfig(db: DB): Promise<StorageConfig> {
    return getSetting(db, STORAGE_KEY, STORAGE_DEFAULTS);
}

/** The configured bucket, or null when backups are off or not set up. */
export async function openBucket(db: DB): Promise<Bucket | null> {
    const c = await storageConfig(db);
    if (!c.enabled || !c.endpoint || !c.bucket || !c.accessKeyId || !c.secretEncrypted) return null;
    return new Bucket(c, decrypt(c.secretEncrypted));
}
