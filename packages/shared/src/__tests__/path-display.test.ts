import { describe, expect, it } from "vitest";
import { formatFilesystemPath, formatPathRelativeToDirectories } from "../path-display";

describe("formatFilesystemPath", () => {
  it.each(["", "/", "/home/operator/a\\b", "src/file.ts", "https://example.test/a/b", "file:///C:/repo/a"])(
    "preserves POSIX paths, relative paths, and URLs: %s",
    (value) => expect(formatFilesystemPath(value)).toBe(value),
  );
});

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

  it("formats absolute Windows paths outside the known directories", () => {
    expect(formatPathRelativeToDirectories("D:/other/file.ts", ["C:/repo"]))
      .toBe("D:\\other\\file.ts");
    expect(formatPathRelativeToDirectories("//server/share/file.ts", []))
      .toBe("\\\\server\\share\\file.ts");
  });

  it("preserves literal POSIX backslashes and path-component boundaries", () => {
    expect(formatPathRelativeToDirectories("/repo/a\\b/file.ts", ["/repo"]))
      .toBe("a\\b/file.ts");
    expect(formatPathRelativeToDirectories("/repo\\other/file.ts", ["/repo"]))
      .toBe("/repo\\other/file.ts");
  });

  it("fuzzes separator combinations across drive, UNC, and extended Windows roots", () => {
    const roots = ["C:", "z:", "\\\\server\\share", "\\\\?\\C:", "\\\\?\\UNC\\server\\share"];
    const names = ["src", "two words", "日本語", "café", "[draft]", "a#b", "100%", ".codex"];
    const failures: string[] = [];
    let failureCount = 0;
    let caseCount = 0;
    // Exhaust every separator assignment, including UNC prefixes. The
    // expected path is assembled independently from the original segments.
    for (const root of roots) {
      for (const name of names) {
        const nativeRoot = `${root}\\project`;
        const nativePath = `${nativeRoot}\\${name}\\file.ts`;
        const separatorCount = [...nativePath].filter((char) => char === "\\").length;
        for (let mask = 0; mask < 2 ** separatorCount; mask += 1) {
          let separatorIndex = 0;
          const input = nativePath.replace(/\\/g, () =>
            mask & (1 << separatorIndex++) ? "/" : "\\",
          );
          const actual = [
            formatFilesystemPath(input),
            formatFilesystemPath(formatFilesystemPath(input)),
            formatPathRelativeToDirectories(input, []),
            formatPathRelativeToDirectories(input, [nativeRoot]),
          ];
          const expected = [nativePath, nativePath, nativePath, `${name}\\file.ts`];
          caseCount += 1;
          if (actual.some((value, index) => value !== expected[index])) {
            failureCount += 1;
            if (failures.length < 5) failures.push(JSON.stringify({ input, actual, expected }));
          }
        }
      }
    }
    expect(failureCount, `${failureCount}/${caseCount} cases failed:\n${failures.join("\n")}`).toBe(0);
  });
});
