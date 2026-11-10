import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "website-agent-production.spec.ts",
  tsconfig: "website-agent-production.tsconfig.json",
  outputDir: "../../output/playwright/website-agent-production",
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["junit", { outputFile: "output/playwright/website-agent-production/results.xml" }]],
  use: {
    browserName: "chromium",
    ...(process.env.CI ? { channel: "chrome" } : {}),
    launchOptions: { chromiumSandbox: true },
    viewport: { width: 390, height: 844 },
    locale: "zh-CN",
    timezoneId: "UTC",
    serviceWorkers: "block",
    // Actual opaque cookies are only in memory. Never capture headers/storage in traces/HAR.
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
  },
});
