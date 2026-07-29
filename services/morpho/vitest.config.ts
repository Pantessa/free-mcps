import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./") },
  },
  ssr: {
    noExternal: ["@yeetful/mcp-kit"],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globals: false,
    testTimeout: 20_000,
    setupFiles: ["./tests/setup.ts"],
    server: {
      deps: {
        inline: ["@yeetful/mcp-kit", "next"],
      },
    },
  },
});
