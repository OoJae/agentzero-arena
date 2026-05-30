import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dashboard is read-only over the arena DB; the worker is a separate
  // long-lived process. Keep Next lean and avoid bundling server-only deps.
  reactStrictMode: true,
  // node:sqlite is a built-in; ensure it is treated as external on the server.
  serverExternalPackages: ["node:sqlite"],
};

export default nextConfig;
