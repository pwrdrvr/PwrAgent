import { describe, expect, it, vi } from "vitest";
import { buildGithubPrAuthenticationNotice } from "../github-pr-authentication-notice";

describe("buildGithubPrAuthenticationNotice", () => {
  it("builds a sticky error notice with an actionable CLI detail", () => {
    const notice = buildGithubPrAuthenticationNotice({
      event: { occurredAt: 123, detail: "gh auth status failed" },
      onDismiss: vi.fn(),
      onOpenGitSettings: vi.fn(),
    });

    expect(notice).toMatchObject({
      autoDismiss: false,
      detail: "gh auth status failed",
      id: "github-pr-authentication-failure",
      title: "GitHub PR status unavailable",
      tone: "error",
    });
    expect(notice.message).toMatch(/GitHub CLI/);
    expect(notice.actions?.map((action) => action.label)).toEqual([
      "Dismiss",
      "Open Git settings",
    ]);
  });
});
