import type { GithubPrAuthenticationFailureEvent } from "../../../../shared/github-pr-access";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function buildGithubPrAuthenticationNotice(params: {
  event: GithubPrAuthenticationFailureEvent;
  onDismiss: () => void;
  onOpenGitSettings: () => void;
}): AppNoticeToastNotice {
  return {
    actions: [
      { label: "Dismiss", onClick: params.onDismiss },
      {
        label: "Open Git settings",
        onClick: params.onOpenGitSettings,
        tone: "primary",
      },
    ],
    autoDismiss: false,
    ...(params.event.detail ? { detail: params.event.detail } : {}),
    id: "github-pr-authentication-failure",
    message:
      "PwrAgent couldn't read pull request status through the GitHub CLI. Check `gh auth status`, then re-authenticate with `gh auth login` if needed.",
    title: "GitHub PR status unavailable",
    tone: "error",
  };
}
