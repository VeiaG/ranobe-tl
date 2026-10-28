// Bundles the worker and the migration runner into single files for the Docker image.
import { build } from "esbuild";

const shared = {
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outdir: "dist",
    outExtension: { ".js": ".mjs" },
    tsconfig: "tsconfig.json",
    // pg tries these optional modules; they are never used here
    external: ["pg-native", "cloudflare:sockets"],
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: "info",
};

await build({ ...shared, entryPoints: { worker: "src/worker/main.ts", migrate: "src/db/migrate.ts" } });
