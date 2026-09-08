import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("modern_consumers_never_call_deprecated_collection_methods", () => {
  const root = fileURLToPath(new URL("../../renderer/src/", import.meta.url));
  const violations: string[] = [];
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (["__tests__", "test", "fixtures"].includes(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (/\.tsx?$/.test(entry.name)) {
        const source = readFileSync(filename, "utf8");
        if (/\.(?:getNavigationSnapshot|getNavigationSnapshotTransport|listThreads)\s*(?:\?\.)?\(/.test(source)) {
          violations.push(path.relative(root, filename));
        }
      }
    }
  }
  visit(root);
  for (const filename of [
    "federated-thread-target-service.ts",
    "federated-thread-message-service.ts",
    "federation-collection-client.ts",
  ]) {
    const source = readFileSync(new URL(`../federation/${filename}`, import.meta.url), "utf8");
    if (/\.(?:getNavigationSnapshot|listThreads)\s*\(/.test(source)) {
      violations.push(filename);
    }
  }
  expect(violations).toEqual([]);
});
