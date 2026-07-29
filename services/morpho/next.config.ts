import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The mcp-kit is a workspace source package (TS), so let Next transpile it.
  transpilePackages: ["@yeetful/mcp-kit"],
};

export default nextConfig;
