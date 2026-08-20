import type { ManagedGrokSignatureRejectedEvent } from "../../../../shared/managed-grok-signature";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

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
      params.event.removed
        ? "The download was deleted and never run."
        : "The download could not be deleted — remove it manually.",
      params.event.detail,
    ].join("\n"),
    id: `managed-grok-signature:${params.event.directory}`,
    message:
      `The downloaded Grok runtime${release} is not signed by the same`
      + " identity as this copy of PwrAgent, so PwrAgent refused to run it."
      + " Grok stays unavailable until a correctly signed build downloads.",
    title: "Grok download rejected: wrong signature",
    tone: "error",
  };
}
