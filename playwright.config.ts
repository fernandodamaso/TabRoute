import { defineConfig } from "@playwright/test";

const isCi = process.env.CI === "true";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  reporter: isCi
    ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "list",
  use: { browserName: "chromium" }
});
