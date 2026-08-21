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
          owner: "EXAMPLE",
          repo: "catalog-service",
        },
      },
      onDismiss,
      onOpenGitSettings,
    });

    expect(notice).toMatchObject({
      autoDismiss: false,
      detail: "Repository: github.com/EXAMPLE/catalog-service · Branch: main",
      id: "github-pr-saml:github:example/catalog-service",
      title: "GitHub access blocked by SSO",
      tone: "error",
    });
    expect(notice.message).toMatch(/SAML SSO/);
    expect(notice.actions?.map((action) => action.label)).toEqual([
      "Open Git settings",
    ]);

    notice.onDismiss?.();
    notice.actions?.[0]?.onClick();
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
