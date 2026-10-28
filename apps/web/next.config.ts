import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
    output: "standalone",
    outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
    transpilePackages: ["@ranobe-tl/core"],
    serverExternalPackages: ["pg", "pg-boss"],
    typedRoutes: false,
};

export default config;
