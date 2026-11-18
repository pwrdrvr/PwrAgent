import { type FullAccessEscalationContext, type MessagingFullAccessControls } from "./messaging-callback-helpers";
import type { MessagingBindingRecord, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import { type FullAccessRiskPresentationMode } from "./messaging-inbound-helpers";

export function normalizeMessagingFullAccessControls(
  resolved: MessagingFullAccessControls | undefined,
): MessagingFullAccessControls {
  return {
    allowEscalation: resolved?.allowEscalation ?? true,
    allowThreadResume: resolved?.allowThreadResume ?? true,
    warningPolicy: resolved?.warningPolicy ?? "dismissable",
    authorizedUsers: resolved?.authorizedUsers ?? {},
    dismissWarning: resolved?.dismissWarning,
    canDismissWarning: resolved?.canDismissWarning,
  };
}

export type FullAccessRiskPresentation = {
  binding?: MessagingBindingRecord;
  surface?: MessagingSurfaceRef;
};

export function fullAccessRiskPresentationForContext(
  context: FullAccessEscalationContext,
  presentationMode: FullAccessRiskPresentationMode,
): FullAccessRiskPresentation {
  if (presentationMode === "message") {
    return {};
  }
  if (context.kind === "thread") {
    return {
      binding: context.binding,
      surface: context.binding?.statusSurface ?? context.binding?.pinnedStatusSurface,
    };
  }
  return { surface: context.session.surface };
}
