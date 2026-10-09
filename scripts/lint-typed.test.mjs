import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { checkTypedSuppressions, typedLintFiles, typedSuppressionLines } from "./lint-typed.mjs";
import { syntaxLintPaths } from "./lint-syntax.mjs";

const require = createRequire(import.meta.url);
const directories = [];

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pwragent-native-lint-")));
  directories.push(root);
  writeFileSync(join(root, "oxlint.typed.json"), readFileSync("oxlint.typed.json"));
  return root;
}

function source(root, path, text) {
  const filename = join(root, path);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, text);
  return filename;
}

afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("native typed lint correctness", () => {
  it.each([
    "// eslint-disable-next-line @typescript-eslint/unbound-method -- unsafe",
    "// oxlint-disable-line typescript/unbound-method",
    "/* eslint-disable unbound-method */",
    "/* oxlint-disable */",
    "/* eslint-disable no-console, @typescript-eslint/unbound-method */",
    "/* eslint @typescript-eslint/unbound-method: off */",
  ])("rejects a typed suppression independently of the linter: %s", (comment) => {
    expect(typedSuppressionLines("probe.ts", `${comment}\nexport const x = 1;`)).toEqual([1]);
  });

  it("allows syntax-only directives and ignores apparent directives in literals", () => {
    const source = [
      "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
      "export const text = '// eslint-disable';",
      "export const template = `/* oxlint-disable unbound-method */`;",
      "export const regex = /eslint-disable/;",
    ].join("\n");
    expect(typedSuppressionLines("probe.ts", source)).toEqual([]);
  });

  it("covers production in every app and package, excluding test and generated files", () => {
    const root = fixture();
    const paths = [
      "apps/desktop/src/main/service.ts",
      "apps/another/src/view.tsx",
      "packages/shared/src/service.ts",
      "packages/messaging/providers/example/src/service.ts",
    ];
    for (const path of [...paths, "apps/desktop/e2e/spec.ts", "apps/desktop/src/__tests__/spec.ts",
      "packages/shared/src/service.test.ts", "packages/shared/src/__fixtures__/data.ts",
      "packages/shared/dist/generated.ts", "packages/shared/node_modules/dependency.ts"]) {
      source(root, path, "// eslint-disable\nexport const x = 1;");
    }
    expect(typedLintFiles(root).map((path) => path.replaceAll("\\", "/"))).toEqual([...paths].sort());
    expect(checkTypedSuppressions(root)).toHaveLength(paths.length);
  });

  it("runs the native typed backend and catches a lost receiver in the configured production scope", () => {
    const root = fixture();
    source(root, "packages/shared/tsconfig.json", JSON.stringify({
      compilerOptions: { target: "ES2022", strict: true, types: [] }, include: ["src/**/*.ts"],
    }));
    const file = source(root, "packages/shared/src/service.ts", [
      "class Service { value = 1; read() { return this.value; } safe(this: void) { return 1; } }",
      "export const unsafe = new Service().read;",
      "export const safe = new Service().safe;",
    ].join("\n"));
    const packageFile = require.resolve("oxlint/package.json");
    const { bin } = JSON.parse(readFileSync(packageFile, "utf8"));
    const result = spawnSync(process.execPath, [resolve(dirname(packageFile), bin.oxlint),
      "--config", join(root, "oxlint.typed.json"), "--format=json", file,
    ], { cwd: root, encoding: "utf8" });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    const diagnostics = JSON.parse(result.stdout).diagnostics;
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].code).toBe("typescript(unbound-method)");
    expect(diagnostics[0].labels[0].span.line).toBe(2);
  });

  it("preserves unused-binding exemptions and applies hook safety only to renderer files", () => {
    const root = fixture();
    const config = join(root, ".oxlintrc.json");
    writeFileSync(config, readFileSync(".oxlintrc.json"));
    mkdirSync(join(root, "packages"));
    source(root, "vitest.workspace.ts", "const unusedRoot = 1; export {};");
    source(root, "apps/desktop/src/renderer/probe.tsx", [
      'import { useEffect, useState } from "react";',
      "const unused = 1; const _ignored = 1; type _Ignored = string;",
      "export function Bad(enabled: boolean) { if (enabled) useEffect(() => {}); return null; }",
      "export function leading(_first: string, used: string) { return used; }",
    ].join("\n"));
    source(root, "apps/desktop/src/main/probe.ts", [
      'import { useEffect } from "react";',
      "export function Bad(enabled: boolean) { if (enabled) useEffect(() => {}); return null; }",
    ].join("\n"));
    const packageFile = require.resolve("oxlint/package.json");
    const { bin } = JSON.parse(readFileSync(packageFile, "utf8"));
    const result = spawnSync(process.execPath, [resolve(dirname(packageFile), bin.oxlint),
      "--config", config, "--format=json", ...syntaxLintPaths(root),
    ], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    const diagnostics = JSON.parse(result.stdout).diagnostics;
    expect(diagnostics.filter((entry) => entry.code === "eslint(no-unused-vars)")).toHaveLength(3);
    expect(diagnostics.some((entry) => entry.filename === "vitest.workspace.ts")).toBe(true);
    const hooks = diagnostics.filter((entry) => entry.code === "react-hooks(rules-of-hooks)");
    expect(hooks).toHaveLength(1);
    expect(hooks[0].filename.replaceAll("\\", "/")).toContain("src/renderer/");
  });
});
