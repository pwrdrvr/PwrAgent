import type { AppServerPendingRequestNotification } from "./contracts/normalized-app-server";

export type PendingRequestDecision = "approve" | "decline" | "cancel";

export function buildPendingRequestResponse(
  request: AppServerPendingRequestNotification,
  decision: PendingRequestDecision,
): { decision: string } {
  const availableDecision = selectAvailableDecision(request.params, decision);
  if (availableDecision) {
    return { decision: availableDecision };
  }

  if (request.method.includes("commandExecution/requestApproval")) {
    return {
      decision:
        decision === "approve"
          ? "accept"
          : decision === "decline"
            ? "decline"
            : "cancel",
    };
  }

  if (request.method.includes("fileChange/requestApproval")) {
    return {
      decision:
        decision === "approve"
          ? "accept"
          : decision === "decline"
            ? "decline"
            : "cancel",
    };
  }

  return { decision };
}

function selectAvailableDecision(
  params: AppServerPendingRequestNotification["params"],
  decision: PendingRequestDecision,
): string | undefined {
  const rawDecisions =
    readDecisionStrings(params.availableDecisions) ?? readDecisionStrings(params.decisions);
  if (!rawDecisions?.length) {
    return undefined;
  }

  const acceptedAliases =
    decision === "approve"
      ? ["accept", "approve", "allow"]
      : decision === "decline"
        ? ["decline", "deny", "reject"]
        : ["cancel", "abort", "stop"];

  return rawDecisions.find((value) =>
    acceptedAliases.some((alias) => value.toLowerCase().includes(alias)),
  );
}

function readDecisionStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return undefined;
      }
      const record = entry as Record<string, unknown>;
      for (const key of ["decision", "value", "name", "id"]) {
        const raw = record[key];
        if (typeof raw === "string" && raw.trim()) {
          return raw.trim();
        }
      }
      return undefined;
    })
    .filter((entry): entry is string => Boolean(entry));
}
