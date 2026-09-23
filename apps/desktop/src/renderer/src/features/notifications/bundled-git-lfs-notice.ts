import type { BundledGitLfsAdvisoryEvent } from "../../../../shared/bundled-git-lfs";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

export function buildBundledGitLfsNotice(params: {
  event: BundledGitLfsAdvisoryEvent;
  onDismiss: () => void;
  onOpenGitSettings: () => void;
}): AppNoticeToastNotice {
  return {
    actions: [
      {
        label: "Open Git settings",
        onClick: params.onOpenGitSettings,
        tone: "primary",
      },
    ],
    autoDismiss: false,
    detail: params.event.repositoryPath,
    id: "bundled-git-lfs-advisory",
    message:
      "PwrAgent's bundled Git LFS set this repository up. Git outside PwrAgent has no git-lfs, so `git push` from your own terminal will fail there until you install Git LFS.",
    onDismiss: params.onDismiss,
    title: "Git LFS set up in this repository",
    tone: "warning",
  };
}
