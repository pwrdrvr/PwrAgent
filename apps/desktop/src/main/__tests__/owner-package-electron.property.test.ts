import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import fc from "fast-check";
import { afterAll, expect, it } from "vitest";
import { findElectronDependencies } from "../../../../../scripts/check-desktop-owner-electron.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-electron-packages-"));
const require = createRequire(import.meta.url);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

it("rejects direct and transitive npm Electron dependencies, including deferred requires", async () => {
  await fc.assert(fc.asyncProperty(fc.nat({ max: 9999 }), fc.boolean(), async (id, deferred) => {
    const directory = path.join(root, `fixture-${id}-${deferred}`);
    const dependency = path.join(directory, "node_modules", "ui-package");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name: "ui-package", main: "index.cjs" }));
    fs.writeFileSync(path.join(dependency, "index.cjs"), 'module.exports = require("./internal.cjs");');
    fs.writeFileSync(path.join(dependency, "internal.cjs"), deferred ? 'module.exports = () => require("electron");' : 'module.exports = require("electron");');
    const entry = path.join(directory, "owner.ts");
    fs.writeFileSync(entry, 'import dependency from "ui-package"; export { dependency };');
    expect(await findElectronDependencies([entry], directory)).toEqual([{ path: "node_modules/ui-package/internal.cjs", module: "electron" }]);
  }), { numRuns: 12 });
});

it.each([
  { specifier: "electron-log/main.js", electron: true },
  { specifier: "electron-log/node.js", electron: false },
])("checks the actual $specifier entry without executing it", async ({ specifier, electron }) => {
  const entry = path.join(root, specifier.includes("main") ? "main-owner.ts" : "node-owner.ts");
  fs.writeFileSync(entry, `export { default } from ${JSON.stringify(require.resolve(specifier))};`);
  const findings = await findElectronDependencies([entry], root);
  expect(findings.some((finding) => finding.module === "electron")).toBe(electron);
});
