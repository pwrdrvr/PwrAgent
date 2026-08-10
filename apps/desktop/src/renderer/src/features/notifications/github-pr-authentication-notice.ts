import type { GithubPrAuthenticationFailureEvent } from "../../../../shared/github-pr-authentication";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function buildGithubPrAuthenticationNotice(
  event: GithubPrAuthenticationFailureEvent,
): AppNoticeToastNotice {
  return {
    autoDismiss: false,
    ...(event.detail ? { detail: event.detail } : {}),
    id: "github-pr-authentication-failure",
    message:
      "PwrAgent couldn't read pull request status through the GitHub CLI. Check `gh auth status`, then re-authenticate with `gh auth login` if needed.",
    title: "GitHub PR status unavailable",
    tone: "warning",
  };
}
