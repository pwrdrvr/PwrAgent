import { describe, expect, it, vi } from "vitest";
import { buildGithubPrSamlEnforcementNotice } from "../github-pr-saml-notice";

describe("buildGithubPrSamlEnforcementNotice", () => {
  it("builds a sticky error notice with recovery actions", () => {
    const onDismiss = vi.fn();
    const onOpenApplications = vi.fn();
    const notice = buildGithubPrSamlEnforcementNotice({
      event: {
        branch: "main",
        cwd: "/work/giphy-services",
        occurredAt: 123,
      },
      onDismiss,
      onOpenApplications,
    });

    expect(notice).toMatchObject({
      autoDismiss: false,
      detail: "Repository: /work/giphy-services · Branch: main",
      id: "github-pr-saml:/work/giphy-services",
      title: "GitHub access blocked by SSO",
      tone: "error",
    });
    expect(notice.message).toMatch(/SAML SSO/);
    expect(notice.actions?.map((action) => action.label)).toEqual([
      "Dismiss",
      "Open Applications",
    ]);

    notice.actions?.[0]?.onClick();
    notice.actions?.[1]?.onClick();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(onOpenApplications).toHaveBeenCalledOnce();
  });
});
