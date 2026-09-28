import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("loads the gateway validators through Node's native ESM loader", () => {
  const source = readFileSync(new URL("../mcp-connections/mcp-gateway-catalog.ts", import.meta.url), "utf8");
  // Electron's build leaves these dependencies external. Vitest's resolver
  // accepts extensionless subpaths that the production ESM loader rejects.
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const probe = `${outputText}
    import assert from "node:assert/strict";
    for (const $schema of [
      "http://json-schema.org/draft-07/schema#",
      "https://json-schema.org/draft/2019-09/schema",
      "https://json-schema.org/draft/2020-12/schema",
    ]) {
      const tool = { name: "fixture", inputSchema: {
        $schema, type: "object", required: ["id"],
        properties: { id: { type: "string" } },
      } };
      validateGatewayArguments(tool, { id: "record" });
      assert.throws(() => validateGatewayArguments(tool, { id: 7 }));
    }
    console.log("validated all three drafts");
  `;
  expect(execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, NODE_OPTIONS: "" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()).toBe("validated all three drafts");
});
