import { describe, expect, it } from "vitest";
import { buildGithubPrAuthenticationNotice } from "../github-pr-authentication-notice";

describe("buildGithubPrAuthenticationNotice", () => {
  it("builds a sticky error notice with actionable CLI detail", () => {
    expect(buildGithubPrAuthenticationNotice({
      occurredAt: 123,
      detail: "gh auth status failed",
    })).toMatchObject({
      autoDismiss: false,
      detail: "gh auth status failed",
      id: "github-pr-authentication-failure",
      title: "GitHub PR status unavailable",
      tone: "warning",
    });
  });
});
