import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@tvic/core", "@tvic/tracing"],
  // Pin the file-tracing root to the monorepo root for deterministic deploys
  // (otherwise Next infers it from an outer lockfile and warns).
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
