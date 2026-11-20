import { describeModelVerification } from "@pwragent/shared/model-routing";
import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import type { FederationInstanceId } from "@pwragent/shared/contracts/federation";
import type { AppNoticeToastNotice } from "./AppNoticeToast";

/**
 * A provider's request for additional account verification. It is an account
 * task the owner may miss in an unfocused thread, so it gets a sticky notice;
 * the turn itself keeps running and nothing waits on it.
 */
export function buildModelVerificationNotice(params: {
  backend: AppServerBackendKind;
  threadId: string;
  turnId: string;
  verifications: readonly string[];
  instanceId?: FederationInstanceId;
  threadLabel: string;
}): AppNoticeToastNotice | undefined {
  const verifications = [...new Set(params.verifications)];
  if (verifications.length === 0) return undefined;
  const described = verifications.map(describeModelVerification);
  return {
    // One notice per turn: a repeat of the same request replaces it.
    id: `model-verification:${JSON.stringify([
      params.instanceId ?? "local",
      params.backend,
      params.threadId,
      params.turnId,
    ])}`,
    autoDismiss: false,
    tone: "warning",
    title: described.length === 1
      ? `Verification requested: ${described[0]!.label}`
      : "Account verification requested",
    message: described.map((entry) => entry.detail).join("\n"),
    detail: params.threadLabel,
    threadLink: {
      backend: params.backend,
      threadId: params.threadId,
      title: params.threadLabel,
      ...(params.instanceId ? { instanceId: params.instanceId } : {}),
    },
  };
}
