import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

describe("messaging docs links", () => {
  it("keeps README messaging docs links resolvable", () => {
    const readme = readText("README.md");
    const links = [...readme.matchAll(/\[.*?\]\((docs\/messaging-[^)]+\.md)\)/g)].map(
      (match) => match[1],
    );

    expect(links).toEqual([
      "docs/messaging-platform-integration.md",
      "docs/messaging-adapter-contract.md",
    ]);
    for (const link of links) {
      expect(existsSync(path.join(repoRoot, link))).toBe(true);
    }
  });

  it("links the operator guide and adapter contract together", () => {
    const operatorGuide = readText("docs/messaging-platform-integration.md");
    const adapterContract = readText("docs/messaging-adapter-contract.md");

    expect(operatorGuide).toContain("(messaging-adapter-contract.md)");
    expect(adapterContract).toContain("packages/shared/src/contracts/messaging.ts");
  });

  it("does not include obvious real messaging tokens", () => {
    const docs = [
      readText("docs/messaging-platform-integration.md"),
      readText("docs/messaging-adapter-contract.md"),
    ].join("\n");

    expect(docs).not.toMatch(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/);
    expect(docs).not.toMatch(/\b(mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,})\b/);
  });
});

function readText(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}
