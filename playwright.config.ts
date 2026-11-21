import process from "node:process";
import { defineConfig, devices } from "@playwright/test";

const PORT = 3111;

/**
 * Drives the production build against the local chain. `pnpm preview` starts Anvil,
 * deploys the contracts when needed, then builds and serves the site.
 *
 * The partners are off here: the tests speak for them with their keys, so each test
 * decides how the committee votes. Meetings with the real model are tested in
 * web/tests/meeting.test.ts.
 */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], channel: "chrome" } },
    { name: "phone", use: { ...devices["Pixel 7"], channel: "chrome" } },
  ],
  webServer: {
    command: "pnpm preview",
    env: { PORT: String(PORT), NEXT_PUBLIC_NETWORKS: "local", COMMITTEE: "off" },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
