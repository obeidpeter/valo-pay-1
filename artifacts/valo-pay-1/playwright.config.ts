import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  testIgnore: "**/database/**",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4174",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-firefox", use: { ...devices["Desktop Firefox"] } },
    {
      name: "mobile-webkit",
      use: { ...devices["iPhone 13"], defaultBrowserType: "webkit" },
    },
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        },
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 7"],
        defaultBrowserType: "chromium",
        launchOptions: {
          executablePath:
            process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        },
      },
    },
  ],
  webServer: {
    command: "node ../../scripts/node_modules/tsx/dist/cli.mjs e2e/server.ts",
    url: "http://127.0.0.1:4174",
    reuseExistingServer: false,
    env: { VALO_PAY_1_BROWSER_TEST: "1" },
    timeout: 30000,
  },
});
