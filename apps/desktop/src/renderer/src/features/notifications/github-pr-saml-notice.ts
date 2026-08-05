import {
  githubPrAccessTargetKey,
  type GithubPrSamlEnforcementEvent,
} from "../../../../shared/github-pr-access";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function buildGithubPrSamlEnforcementNotice(params: {
  event: GithubPrSamlEnforcementEvent;
  onDismiss: () => void;
  onOpenGitSettings: () => void;
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
        label: "Open Git settings",
        onClick: params.onOpenGitSettings,
        tone: "primary",
      },
    ],
    autoDismiss: false,
    detail: `Repository: ${formatAccessTarget(params.event)}${branchDetail}`,
    id: `github-pr-saml:${githubPrAccessTargetKey(params.event.target)}`,
    message:
      "PwrAgent can't read pull requests for this repository because its organization requires SAML SSO. Re-authorize the GitHub CLI for that organization, then retry.",
    title: "GitHub access blocked by SSO",
    tone: "error",
  };
}

function formatAccessTarget(event: GithubPrSamlEnforcementEvent): string {
  return `github.com/${event.target.owner}/${event.target.repo}`;
}
