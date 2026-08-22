import type { ManagedGrokSignatureRejectedEvent } from "../../../../shared/managed-grok-signature";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

function rejectionRemovalDetail(
  event: ManagedGrokSignatureRejectedEvent,
): string {
  if (event.stage === "download") {
    return event.removed
      ? "PwrAgent refused to run this download and deleted it before installation."
      : "PwrAgent refused to run this download but could not delete it — remove it manually.";
  }
  return event.removed
    ? "PwrAgent refused to run this installed runtime during this validation attempt and deleted it."
    : "PwrAgent refused to run this installed runtime during this validation attempt but could not delete it — remove it manually.";
}

/**
 * Never auto-dismisses. The download runs behind whatever the operator was
 * doing, so this notice has to outlive the screen that started it — and a
 * signer mismatch is the one managed-runtime failure worth interrupting for.
 */
export function buildManagedGrokSignatureRejectedNotice(params: {
  event: ManagedGrokSignatureRejectedEvent;
  onDismiss: () => void;
}): AppNoticeToastNotice {
  const release = params.event.tag ? ` ${params.event.tag}` : "";
  const runtimeKind = params.event.stage === "download"
    ? "downloaded Grok runtime"
    : "installed Grok runtime";
  return {
    actions: [
      {
        label: "Dismiss",
        onClick: params.onDismiss,
      },
    ],
    autoDismiss: false,
    copyText: params.event.detail,
    detail: [
      `Location: ${params.event.directory}`,
      rejectionRemovalDetail(params.event),
      params.event.detail,
    ].join("\n"),
    id: `managed-grok-signature:${params.event.directory}`,
    message:
      `The ${runtimeKind}${release} is not signed by the same`
      + " identity as this copy of PwrAgent, so PwrAgent refused to run it."
      + " PwrAgent only activates managed runtimes that pass this validation.",
    title: params.event.stage === "download"
      ? "Grok download rejected: wrong signature"
      : "Installed Grok runtime rejected: wrong signature",
    tone: "error",
  };
}
