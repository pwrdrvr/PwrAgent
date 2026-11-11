import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

it("loads the gateway validators through Node's native ESM loader", () => {
  const transpile = (file: string): string => ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // Electron's build leaves these dependencies external. Vitest's resolver
  // accepts extensionless subpaths that the production ESM loader rejects.
  // The catalog loads them through mcp-sdk.ts, inlined here as one module.
  const loaders = transpile("../mcp-connections/mcp-sdk.ts").replace(/^export /gm, "");
  const catalog = transpile("../mcp-connections/mcp-gateway-catalog.ts");
  const sdkImport = /^import \{[^}]*\} from "\.\/mcp-sdk";$/m;
  expect(catalog).toMatch(sdkImport);
  const probe = `${loaders}
    ${catalog.replace(sdkImport, "")}
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
      await validateGatewayArguments(tool, { id: "record" });
      await assert.rejects(validateGatewayArguments(tool, { id: 7 }), { code: -32602 });
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
