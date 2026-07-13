import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Keep the complete database suite deterministic on constrained Windows and CI hosts.
    // Vitest otherwise forks one worker per available core, which can exhaust virtual memory.
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
    coverage: {
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
    },
  },
});
