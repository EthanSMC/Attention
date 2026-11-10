import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    authInterrupts: true,
    // Shared Node-oriented TS packages use .js specifiers before compilation.
    extensionAlias: { ".js": [".ts", ".tsx", ".js"] },
  },
  output: "standalone",
  outputFileTracingRoot: workspaceRoot,
  poweredByHeader: false,
  // Pi uses native Node loaders. Keep those published modules intact rather
  // than rewriting their dynamic builtin imports into webpack contexts.
  serverExternalPackages: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
  ],
  transpilePackages: [
    "@attention/auth",
    "@attention/collector",
    "@attention/content-reader",
    "@attention/content-reader-contracts",
    "@attention/fetcher",
    "@attention/contracts",
    "@attention/db",
    "@attention/domain",
    "@attention/website-agent"
  ]
};

export default nextConfig;
