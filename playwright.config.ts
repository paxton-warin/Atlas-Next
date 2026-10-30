import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: "*.spec.ts",
  // Dynamic/game detection remains explicitly deferred in this combined update.
  // Retain its historical audit source; do not treat it as a current acceptance gate.
  testIgnore: ["**/dynamic-fingerprint.spec.ts"],
  timeout: 60000,
  expect: { timeout: 20000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "evidence/browser-results.json" }],
  ],
  use: {
    baseURL: "http://localhost:4180",
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath:
        process.env.CHROME_PATH ||
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    },
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/serve.mjs",
    url: "http://localhost:4180/health",
    reuseExistingServer: process.env.ATLAS_TEST_REUSE_SERVER === "1",
    timeout: 30000,
  },
});
