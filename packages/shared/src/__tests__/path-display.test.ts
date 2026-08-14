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

  it("uses Windows separators for protocol paths under a Windows directory", () => {
    expect(
      formatPathRelativeToDirectories(
        "C:/repo/worktree/apps/desktop/src/main.ts",
        ["C:\\repo\\worktree"],
      ),
    ).toBe("apps\\desktop\\src\\main.ts");
    expect(
      formatPathRelativeToDirectories(
        "breakfasts/eggs/sunny-side-up.md",
        ["C:\\repo\\worktree"],
      ),
    ).toBe("breakfasts\\eggs\\sunny-side-up.md");
  });

  it("matches UNC paths and preserves their separators", () => {
    expect(
      formatPathRelativeToDirectories(
        "\\\\server\\share\\repo\\apps\\desktop\\src\\main.ts",
        ["\\\\server\\share\\repo"],
      ),
    ).toBe("apps\\desktop\\src\\main.ts");
    expect(
      formatPathRelativeToDirectories(
        "\\\\server\\share\\other\\apps\\desktop\\src\\main.ts",
        ["\\\\server\\share\\repo"],
      ),
    ).toBe("\\\\server\\share\\other\\apps\\desktop\\src\\main.ts");
  });

  it("leaves POSIX relative paths unchanged when no Windows directory is known", () => {
    expect(
      formatPathRelativeToDirectories(
        "apps/desktop/src/main.ts",
        ["/repo/worktree"],
      ),
    ).toBe("apps/desktop/src/main.ts");
  });
});
