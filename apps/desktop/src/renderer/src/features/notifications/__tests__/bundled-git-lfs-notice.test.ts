import { describe, expect, it, vi } from "vitest";
import { buildBundledGitLfsNotice } from "../bundled-git-lfs-notice";

describe("buildBundledGitLfsNotice", () => {
  it("builds a sticky advisory naming the repository and the push that fails", () => {
    const notice = buildBundledGitLfsNotice({
      event: { occurredAt: 123, repositoryPath: "/Users/alice/code/assets" },
      onDismiss: vi.fn(),
      onOpenGitSettings: vi.fn(),
    });

    expect(notice).toMatchObject({
      autoDismiss: false,
      detail: "/Users/alice/code/assets",
      id: "bundled-git-lfs-advisory",
      title: "Git LFS set up in this repository",
      // An advisory about the operator's own terminal, not a failure of ours.
      tone: "warning",
    });
    expect(notice.message).toMatch(/git push/);
    expect(notice.message).toMatch(/install Git LFS/);
    expect(notice.actions?.map((action) => action.label)).toEqual([
      "Open Git settings",
    ]);
  });
});
