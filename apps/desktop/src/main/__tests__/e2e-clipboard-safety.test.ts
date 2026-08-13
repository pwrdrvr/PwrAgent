import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const e2eDir = path.resolve(import.meta.dirname, "../../../e2e");
const forbiddenClipboardPatterns = [
  /\bclipboard\.(?:clear|write|writeBuffer|writeHTML|writeImage|writeText)\b/,
  /(?:Meta|Control)\+[CV]\b/,
  /execCommand\(["']copy["']\)/,
] as const;

async function listSpecFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return await listSpecFiles(entryPath);
    }
    return entry.name.endsWith(".spec.ts") ? [entryPath] : [];
  }));
  return nested.flat();
}

describe("desktop E2E clipboard safety", () => {
  it("does not access the host clipboard or native copy/paste shortcuts", async () => {
    const violations: string[] = [];
    for (const specPath of await listSpecFiles(e2eDir)) {
      const source = await readFile(specPath, "utf8");
      for (const pattern of forbiddenClipboardPatterns) {
        if (pattern.test(source)) {
          violations.push(`${path.relative(e2eDir, specPath)}: ${pattern.source}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
