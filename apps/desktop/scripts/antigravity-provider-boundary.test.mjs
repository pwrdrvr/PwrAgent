import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "vitest";

const providerSource = new URL("../src/main/", import.meta.url);
const forbiddenQuotaRoute = /["']--print["'],\s*["']\/usage["']|cloudcode-pa\.googleapis\.com|retrieveUserQuotaSummary|fetchAvailableModels|antigravity-oauth-token|antigravity\/hub/i;
const otherAcpClientIdentity = /clientInfo:\s*\{[^}]*\bname:\s*["'](?:zed|jetbrains|xcode|android-studio)["']/i;

test("Antigravity integrations use ACP without a quota side channel or borrowed identity", () => {
  const violations = [];
  for (const folder of ["acp/", "app-server/"]) {
    const directory = new URL(folder, providerSource);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const source = readFileSync(new URL(entry.name, directory), "utf8");
      if (forbiddenQuotaRoute.test(source) || otherAcpClientIdentity.test(source)) {
        violations.push(`${folder}${entry.name}`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
