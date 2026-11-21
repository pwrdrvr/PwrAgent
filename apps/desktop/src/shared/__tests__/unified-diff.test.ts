import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../unified-diff";

describe("parseUnifiedDiff", () => {
  it("keeps adjacent hunks distinct and strips patch headers from content rows", () => {
    const parsed = parseUnifiedDiff(
      [
        "diff --git a/src/example.ts b/src/example.ts",
        "index 123..456 100644",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,2 +1,2 @@",
        "-const alpha = 1;",
        "+const alpha = 2;",
        "@@ -4,2 +4,2 @@",
        "-const beta = 3;",
        "+const beta = 4;"
      ].join("\n")
    );

    expect(parsed).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "removed", oldNumber: 1, text: "const alpha = 1;" },
      { kind: "added", newNumber: 1, text: "const alpha = 2;" },
      { kind: "hunk", text: "@@ -4,2 +4,2 @@" },
      { kind: "removed", oldNumber: 4, text: "const beta = 3;" },
      { kind: "added", newNumber: 4, text: "const beta = 4;" },
    ]);
  });

  it("returns no rows for a blank diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
