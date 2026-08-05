import { describe, expect, it } from "vitest";
import { formatPathRelativeToDirectories } from "../path-display";

describe("formatPathRelativeToDirectories", () => {
  it("uses the longest matching directory on a path-component boundary", () => {
    expect(
      formatPathRelativeToDirectories(
        "/repo/worktrees/pwragent/apps/desktop/src/main.ts",
        ["/repo", "/repo/worktrees/pwragent"],
      ),
    ).toBe("apps/desktop/src/main.ts");
    expect(
      formatPathRelativeToDirectories(
        "/repo-other/apps/desktop/src/main.ts",
        ["/repo"],
      ),
    ).toBe("/repo-other/apps/desktop/src/main.ts");
  });

  it("matches Windows paths and preserves their separators", () => {
    expect(
      formatPathRelativeToDirectories(
        "C:\\repo\\worktree\\apps\\desktop\\src\\main.ts",
        ["c:\\repo", "C:\\repo\\worktree\\"],
      ),
    ).toBe("apps\\desktop\\src\\main.ts");
    expect(
      formatPathRelativeToDirectories(
        "C:\\repo-other\\apps\\desktop\\src\\main.ts",
        ["c:\\repo"],
      ),
    ).toBe("C:\\repo-other\\apps\\desktop\\src\\main.ts");
  });
});
