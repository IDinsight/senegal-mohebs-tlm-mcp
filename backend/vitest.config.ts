import { defineConfig } from "vitest/config";

// Only run the TypeScript tests under src/. Without this, vitest also picks up
// the compiled copies under dist/, running every suite twice against stale build
// output.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
