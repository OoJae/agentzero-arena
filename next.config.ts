import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard is read-only over the arena DB; the worker is a separate
  // long-lived process. Keep Next lean and avoid bundling server-only deps.
  reactStrictMode: true,
  // We use ESM `.js` import specifiers (so the same lib/ files run under tsx and
  // plain node). Teach webpack to resolve `.js` → the real `.ts`/`.tsx` source.
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
