import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 15_000,
  fullyParallel: false,
  workers: 1,
  use: {
    browserName: "chromium",
    headless: true
  }
});
