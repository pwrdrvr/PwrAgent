import { describe, expect, it, vi } from "vitest";
import { buildGithubPrSamlEnforcementNotice } from "../github-pr-saml-notice";

describe("buildGithubPrSamlEnforcementNotice", () => {
  it("builds a sticky error notice with recovery actions", () => {
    const onDismiss = vi.fn();
    const onOpenGitSettings = vi.fn();
    const notice = buildGithubPrSamlEnforcementNotice({
      event: {
        branch: "main",
        occurredAt: 123,
        target: {
          kind: "github-repository",
          owner: "GIPHY",
          repo: "giphy-services",
        },
      },
      onDismiss,
      onOpenGitSettings,
    });

    expect(notice).toMatchObject({
      autoDismiss: false,
      detail: "Repository: github.com/GIPHY/giphy-services · Branch: main",
      id: "github-pr-saml:github:giphy/giphy-services",
      title: "GitHub access blocked by SSO",
      tone: "error",
    });
    expect(notice.message).toMatch(/SAML SSO/);
    expect(notice.actions?.map((action) => action.label)).toEqual([
      "Dismiss",
      "Open Git settings",
    ]);

    notice.actions?.[0]?.onClick();
    notice.actions?.[1]?.onClick();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onOpenGitSettings).toHaveBeenCalledOnce();
  });

  it("labels retained pull requests by their URL repository", () => {
    const notice = buildGithubPrSamlEnforcementNotice({
      event: {
        occurredAt: 123,
        target: {
          kind: "github-repository",
          owner: "historical",
          repo: "retained-repo",
        },
      },
      onDismiss: vi.fn(),
      onOpenGitSettings: vi.fn(),
    });

    expect(notice.detail).toBe(
      "Repository: github.com/historical/retained-repo",
    );
  });
});
