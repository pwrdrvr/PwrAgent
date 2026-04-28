import { describe, expect, it } from "vitest";
import { formatRuntimeBranch, formatRuntimePath } from "../runtime-identity";

describe("runtime identity formatting", () => {
  it("shows the distinctive worktree directory segment", () => {
    expect(
      formatRuntimePath(
        "/Users/huntharo/pwrdrvr/PwrAgnt/.worktrees/pwragnt-fix-thread-naming-moioth2352"
      )
    ).toBe(".worktrees/pwragnt-fix...moioth2352");
  });

  it("shows the codex worktree id and repo for codex-managed worktrees", () => {
    expect(formatRuntimePath("/Users/huntharo/.codex/worktrees/5d4b/PwrAgnt")).toBe(
      "5d4b/PwrAgnt"
    );
  });

  it("middle-truncates branch names", () => {
    expect(formatRuntimeBranch("codex/fix-thread-naming-ephemeral")).toBe(
      "codex/fix-th...g-ephemeral"
    );
  });
});
