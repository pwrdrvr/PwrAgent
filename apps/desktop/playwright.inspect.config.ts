import { defineConfig } from "@playwright/test";
import desktopE2eConfig from "./playwright.config";

export default defineConfig({
  ...desktopE2eConfig,
  testIgnore: [],
  testMatch: "**/*.inspect.spec.ts",
});
