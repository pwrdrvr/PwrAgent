import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(path.resolve(testDir, "../app.css"), "utf8");

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{(?<body>[\\s\\S]*?)\\n\\}`),
  );
  if (!match?.groups?.body) {
    throw new Error(`Expected app.css to define ${selector}`);
  }
  return match.groups.body;
}

describe("review provenance shrink contract", () => {
  it("keeps a long pull-request chip inside the review copy column", () => {
    const body = ruleBody(".transcript-review__provenance > .pr-chip");
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).toMatch(/max-width:\s*100%/);
  });

  it("ellipsizes the pull-request identity after the chip shrinks", () => {
    const body = ruleBody(".transcript-review__provenance .pr-chip__label");
    expect(body).toMatch(/min-width:\s*0/);
    expect(body).toMatch(/overflow:\s*hidden/);
    expect(body).toMatch(/text-overflow:\s*ellipsis/);
  });
});
