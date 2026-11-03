import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    setupFiles: ["./src/testSetup.ts"],
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
