import type { GithubPrSamlEnforcementEvent } from "../../../../shared/github-pr-access";
import { tildifyPath } from "../../lib/tildify-path";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function buildGithubPrSamlEnforcementNotice(params: {
  event: GithubPrSamlEnforcementEvent;
  onDismiss: () => void;
  onOpenApplications: () => void;
}): AppNoticeToastNotice {
  const branchDetail = params.event.branch
    ? ` · Branch: ${params.event.branch}`
    : "";
  return {
    actions: [
      {
        label: "Dismiss",
        onClick: params.onDismiss,
      },
      {
        label: "Open Applications",
        onClick: params.onOpenApplications,
        tone: "primary",
      },
    ],
    autoDismiss: false,
    detail: `Repository: ${tildifyPath(params.event.cwd)}${branchDetail}`,
    id: `github-pr-saml:${params.event.cwd}`,
    message:
      "PwrAgent can't read pull requests for this repository because its organization requires SAML SSO. Re-authorize the GitHub CLI for that organization, then retry.",
    title: "GitHub access blocked by SSO",
    tone: "error",
  };
}
