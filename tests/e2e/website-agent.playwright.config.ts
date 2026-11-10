import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "website-agent-console.spec.ts",
  outputDir: "../../output/playwright/website-agent-console",
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [["list"], ["junit", { outputFile: "output/playwright/website-agent-console/results.xml" }]],
  use: {
    browserName: "chromium",
    // Ubuntu's existing Chrome profile covers the official installed binary.
    // Never change host security or fall back to a sandbox-disabled launch.
    ...(process.env.CI ? { channel: "chrome" } : {}),
    viewport: { width: 1280, height: 900 },
    locale: "zh-CN",
    timezoneId: "UTC",
    serviceWorkers: "block",
    launchOptions: { chromiumSandbox: true },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
