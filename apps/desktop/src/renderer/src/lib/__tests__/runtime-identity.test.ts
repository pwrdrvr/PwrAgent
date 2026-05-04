import { describe, expect, it } from "vitest";
import {
  formatRuntimeBranch,
  formatRuntimeGitRef,
  formatRuntimePath,
  runtimeGitRefCopyValue,
} from "../runtime-identity";

describe("runtime identity formatting", () => {
  it("shows the distinctive worktree directory segment", () => {
    expect(
      formatRuntimePath(
        "/Users/huntharo/pwrdrvr/PwrAgnt/.worktrees/pwragnt-fix-thread-naming-moioth2352"
      )
    ).toBe(".worktrees/pwragnt-fix-th...ng-moioth2352");
  });

  it("ignores the desktop app package when showing the runtime workspace", () => {
    expect(formatRuntimePath("/Users/huntharo/github/PwrAgnt/apps/desktop")).toBe(
      "github/PwrAgnt"
    );
  });

  it("ignores the desktop app package below a repo worktree", () => {
    expect(
      formatRuntimePath(
        "/Users/huntharo/github/PwrAgnt/.worktrees/pwragnt-fix-thread-naming-moioth2352/apps/desktop"
      )
    ).toBe(".worktrees/pwragnt-fix-th...ng-moioth2352");
  });

  it("shows the codex worktree id and repo for codex-managed worktrees", () => {
    expect(formatRuntimePath("/Users/huntharo/.codex/worktrees/5d4b/PwrAgnt")).toBe(
      "5d4b/PwrAgnt"
    );
  });

  it("ignores the desktop app package below a codex-managed worktree", () => {
    expect(
      formatRuntimePath("/Users/huntharo/.codex/worktrees/5d4b/PwrAgnt/apps/desktop")
    ).toBe("5d4b/PwrAgnt");
  });

  it("shows hash/project for the new in-repo worktree layout", () => {
    expect(
      formatRuntimePath(
        "/Users/huntharo/github/PwrAgnt/.worktrees/moit6ddw/PwrAgnt"
      )
    ).toBe("moit6ddw/PwrAgnt");
  });

  it("shows hash/project for the new in-repo layout with collision suffix", () => {
    expect(
      formatRuntimePath(
        "/Users/huntharo/github/PwrAgnt/.worktrees/moit6ddw-2/PwrAgnt"
      )
    ).toBe("moit6ddw-2/PwrAgnt");
  });

  it("ignores the desktop app package below the new in-repo worktree layout", () => {
    expect(
      formatRuntimePath(
        "/Users/huntharo/github/PwrAgnt/.worktrees/moit6ddw/PwrAgnt/apps/desktop"
      )
    ).toBe("moit6ddw/PwrAgnt");
  });

  it("shows hash/project for the user-home worktree layout", () => {
    expect(
      formatRuntimePath("/Users/huntharo/.pwragnt/worktrees/moit6ddw/PwrAgnt")
    ).toBe("moit6ddw/PwrAgnt");
  });

  it("ignores the desktop app package below a user-home worktree", () => {
    expect(
      formatRuntimePath(
        "/Users/huntharo/.pwragnt/worktrees/moit6ddw/PwrAgnt/apps/desktop"
      )
    ).toBe("moit6ddw/PwrAgnt");
  });

  it("middle-truncates branch names", () => {
    expect(formatRuntimeBranch("codex/fix-thread-naming-ephemeral")).toBe(
      "codex/fix-thread-naming-ephemeral"
    );
  });

  it("labels a detached ref as HEAD while copying the commit SHA", () => {
    const identity = {
      commitSha: "ab12cd3344556677889900aabbccddeeff001122",
      cwd: "/repo/PwrAgnt",
      detachedHead: true,
    };

    expect(formatRuntimeGitRef(identity)).toBe("HEAD");
    expect(runtimeGitRefCopyValue(identity)).toBe(
      "ab12cd3344556677889900aabbccddeeff001122"
    );
  });
});
