import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../../../..");

describe("messaging docs links", () => {
  it("keeps messaging docs reachable from the top-level entry points", () => {
    // The README rewrite split top-level docs by audience: README is
    // user-facing, ARCHITECTURE.md is the engineer's first pass, and
    // CONTRIBUTING.md owns developer/operator workflow. Each of the four
    // messaging deep-dives must remain reachable from at least one of
    // those three entry points so visitors and contributors can find them
    // without already knowing the path.
    //
    // - messaging-architecture is the umbrella overview.
    // - messaging-platform-integration covers operator setup.
    // - messaging-adapter-contract is the implementer's contract.
    // - messaging-adding-a-provider is the hands-on walkthrough.
    const entryPoints = ["README.md", "ARCHITECTURE.md", "CONTRIBUTING.md"];
    const links = new Set<string>();
    for (const entry of entryPoints) {
      const body = readText(entry);
      for (const match of body.matchAll(/\[.*?\]\((docs\/messaging-[^)]+\.md)\)/g)) {
        links.add(match[1]);
      }
    }

    expect(links).toEqual(
      new Set([
        "docs/messaging-architecture.md",
        "docs/messaging-adding-a-provider.md",
        "docs/messaging-platform-integration.md",
        "docs/messaging-adapter-contract.md",
      ]),
    );
    for (const link of links) {
      expect(existsSync(path.join(repoRoot, link))).toBe(true);
    }
  });

  it("links the operator guide and adapter contract together", () => {
    const operatorGuide = readText("docs/messaging-platform-integration.md");
    const adapterContract = readText("docs/messaging-adapter-contract.md");

    expect(operatorGuide).toContain("(messaging-adapter-contract.md)");
    // Messaging types now live in @pwragent/messaging-interface (PR #180
    // unified the duplicate type tree out of @pwragent/shared).
    expect(adapterContract).toContain(
      "packages/messaging/interface/src/index.ts",
    );
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
