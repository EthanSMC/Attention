import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  transpilePackages: [
    "@attention/auth",
    "@attention/collector",
    "@attention/contracts",
    "@attention/db",
    "@attention/domain"
  ]
};

export default nextConfig;
