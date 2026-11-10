import fc from "fast-check";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Script } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";

/** Run the shipped function body with the bundle directory supplied by the build. */
function assetResolver(file: URL, name: string) {
  const source = readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file.pathname, source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing asset resolver ${name}`);
  const code = declaration.getText(parsed).replace(/^export\s+/, "") + `\n${name}(...args);`;
  const script = new Script(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2024 } }).outputText);
  return (context: Record<string, unknown>, args: unknown[] = []) => script.runInNewContext({ ...context, args });
}

const renderer = assetResolver(new URL("../shell/window.ts", import.meta.url), "getRendererEntry");
const icon = assetResolver(new URL("../shell/ipc/app-icon-drag.ts", import.meta.url), "resolvePwragentAppIconPath");
const directory = fc.array(fc.constantFrom(..."abc XYZ-π"), { minLength: 1, maxLength: 12 }).map((parts) => parts.join(""));

it("resolves the renderer from the bundle's main directory for every checkout path", () => {
  fc.assert(fc.property(directory, (name) => {
    const desktop = path.join(os.tmpdir(), name, "desktop");
    expect(renderer({ moduleDirectory: path.join(desktop, "out", "main"), process: { env: {} }, join: path.join }))
      .toEqual({ kind: "file", value: path.join(desktop, "out", "renderer", "index.html") });
  }));
});

it("uses the authored icon in both built and source layouts", () => {
  fc.assert(fc.property(directory, (name) => {
    const desktop = path.join(os.tmpdir(), name, "desktop");
    const master = path.join(desktop, "build", "icon.png");
    for (const mainDirectory of [path.join(desktop, "out", "main"), path.join(desktop, "src", "main", "shell", "ipc")]) {
      expect(icon({ __dirname: mainDirectory, process: {}, join: path.join, existsSync: (file: string) => file === master }))
        .toBe(master);
    }
  }));
});
