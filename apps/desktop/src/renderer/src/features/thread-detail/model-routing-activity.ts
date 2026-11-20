import { describeModelReroute, describeModelVerification } from "@pwragent/shared";
import type {
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
} from "@pwragent/shared";

export type ModelRoutingNotification =
  | {
      method: "turn/modelRerouted";
      params: { turnId: string; fromModel: string; toModel: string; reason: string };
    }
  | {
      method: "turn/verificationRequested";
      params: { turnId: string; verifications: string[] };
    };

const ENTRY_ID_PREFIX = "live-model-routing:";

export function modelRoutingActivityEntryId(turnId: string): string {
  return `${ENTRY_ID_PREFIX}${turnId}`;
}

export function isModelRoutingActivityEntry(entry: AppServerThreadActivityEntry): boolean {
  return entry.id.startsWith(ENTRY_ID_PREFIX);
}

/**
 * One live transcript row per turn for model-routing notices. A reroute
 * names the model that actually answered; a verification request names what
 * the provider asked for. Rows merge by id, so a repeated notice replaces its
 * own row and the other kind stays beside it. Safety buffering is a status,
 * not a row: it ends when the hold ends, and is never written here.
 */
export function mergeModelRoutingActivityEntry(
  current: AppServerThreadActivityEntry | undefined,
  notification: ModelRoutingNotification,
  now = Date.now(),
): AppServerThreadActivityEntry | undefined {
  const details = modelRoutingDetails(notification);
  if (details.length === 0) return undefined;
  const id = modelRoutingActivityEntryId(notification.params.turnId);
  const previous = current?.id === id ? current.details : [];
  const merged = [
    ...previous.filter((detail) => !details.some((next) => next.id === detail.id)),
    ...details,
  ];
  return {
    type: "activity",
    id,
    createdAt: current?.id === id ? current.createdAt ?? now : now,
    tone: "warning",
    summary: merged.length === 1
      ? merged[0]!.label
      : `Model routing updates (${merged.length})`,
    status: "completed",
    details: merged,
  };
}

function modelRoutingDetails(
  notification: ModelRoutingNotification,
): AppServerThreadActivityDetail[] {
  if (notification.method === "turn/modelRerouted") {
    const { fromModel, toModel, reason } = notification.params;
    if (!fromModel || !toModel) return [];
    return [{
      id: `reroute:${fromModel}:${toModel}`,
      kind: "command",
      label: describeModelReroute({ fromModel, toModel, reason }),
      status: "completed",
    }];
  }
  return [...new Set(notification.params.verifications)].map((verification) => ({
    id: `verification:${verification}`,
    kind: "command" as const,
    label: `Verification requested: ${describeModelVerification(verification).label}`,
    markdown: describeModelVerification(verification).detail,
    status: "completed" as const,
  }));
}
