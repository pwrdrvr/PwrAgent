import type { AppServerPendingRequestNotification } from "./contracts/normalized-app-server";

export type PendingRequestDecision = "approve" | "decline" | "cancel";
export type PendingRequestActionDecision =
  | "accept"
  | "accept_for_session"
  | "accept_with_execpolicy_amendment"
  | "apply_network_policy_amendment"
  | "decline"
  | "cancel";
export type PendingRequestActionStyle = "primary" | "secondary" | "danger";

export type PendingRequestAction = {
  id: string;
  label: string;
  decision: PendingRequestActionDecision;
  style: PendingRequestActionStyle;
  fallbackText: string;
  response: { decision: unknown };
};

export function buildPendingRequestResponse(
  request: AppServerPendingRequestNotification,
  decision: PendingRequestDecision | PendingRequestAction,
): { decision: unknown } {
  if (typeof decision !== "string") {
    return decision.response;
  }

  const availableAction = selectAvailableAction(request, decision);
  if (availableAction) {
    return availableAction.response;
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

export function buildPendingRequestActions(
  request: AppServerPendingRequestNotification,
): PendingRequestAction[] {
  const availableDecisions =
    readDecisionEntries(request.params.availableDecisions) ??
    readDecisionEntries(request.params.decisions);
  const optionDecisions = availableDecisions
    ? undefined
    : readDecisionEntries(request.params.options);
  const rawDecisions = availableDecisions ?? optionDecisions;
  const preserveStringLabels = Boolean(optionDecisions);
  const provided = rawDecisions
    ?.map((entry, index) =>
      actionFromEntry(request, entry, index, preserveStringLabels),
    )
    .filter((entry): entry is PendingRequestAction => Boolean(entry));
  if (provided?.length) {
    return provided;
  }

  return defaultPendingRequestActions(request);
}

function selectAvailableAction(
  request: AppServerPendingRequestNotification,
  decision: PendingRequestDecision,
): PendingRequestAction | undefined {
  const actions = buildPendingRequestActions(request);
  if (decision === "approve") {
    return (
      actions.find((action) => action.decision === "accept") ??
      actions.find(
        (action) =>
          (action.decision === "accept_for_session" ||
            action.decision === "accept_with_execpolicy_amendment" ||
            action.decision === "apply_network_policy_amendment") &&
          action.style !== "danger",
      )
    );
  }
  const acceptedKind = decision === "decline" ? "decline" : "cancel";
  return actions.find((action) => action.decision === acceptedKind);
}

function readDecisionEntries(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function actionFromEntry(
  request: AppServerPendingRequestNotification,
  entry: unknown,
  index: number,
  preserveStringLabel: boolean,
): PendingRequestAction | undefined {
  if (typeof entry === "string") {
    return actionFromDecisionString(
      request,
      entry,
      preserveStringLabel ? legacyOptionResponseDecision(entry) : entry,
      index,
      preserveStringLabel ? entry : undefined,
    );
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  const label = readString(record.label) ?? readString(record.title);

  const execpolicyPayload =
    record.acceptWithExecpolicyAmendment ??
    record.accept_with_execpolicy_amendment;
  if (execpolicyPayload && typeof execpolicyPayload === "object") {
    return buildAction({
      decision: "accept_with_execpolicy_amendment",
      fallbackText: String(index + 1),
      id: `approval:accept_with_execpolicy_amendment:${index}`,
      label: label ?? execpolicyLabel(execpolicyPayload),
      responseDecision: entry,
      style: "primary",
    });
  }

  const networkPayload =
    record.applyNetworkPolicyAmendment ?? record.apply_network_policy_amendment;
  if (networkPayload && typeof networkPayload === "object") {
    const network = networkPayload as Record<string, unknown>;
    const amendment = network.network_policy_amendment;
    const action =
      amendment && typeof amendment === "object"
        ? readString((amendment as Record<string, unknown>).action)
        : undefined;
    return buildAction({
      decision: "apply_network_policy_amendment",
      fallbackText: String(index + 1),
      id: `approval:apply_network_policy_amendment:${action ?? "rule"}:${index}`,
      label: label ?? networkPolicyLabel(networkPayload),
      responseDecision: entry,
      style: action?.toLowerCase() === "deny" ? "danger" : "primary",
    });
  }

  for (const key of ["decision", "value", "name", "id"]) {
    const raw = readString(record[key]);
    if (raw) {
      return actionFromDecisionString(request, raw, raw, index, label);
    }
  }

  return undefined;
}

function actionFromDecisionString(
  request: AppServerPendingRequestNotification,
  rawDecision: string,
  responseDecision: unknown,
  index: number,
  label?: string,
): PendingRequestAction | undefined {
  const normalized = normalizeDecision(rawDecision);
  if (!normalized) {
    return undefined;
  }

  return buildAction({
    decision: normalized,
    fallbackText: String(index + 1),
    id: `approval:${normalized}`,
    label: label ?? defaultLabel(request, normalized),
    responseDecision,
    style: defaultStyle(normalized),
  });
}

function defaultPendingRequestActions(
  request: AppServerPendingRequestNotification,
): PendingRequestAction[] {
  if (request.method.includes("commandExecution/requestApproval")) {
    return [
      buildAction({
        decision: "accept",
        fallbackText: "1",
        id: "approval:accept",
        label: "Approve Once",
        responseDecision: "accept",
        style: "primary",
      }),
      buildAction({
        decision: "accept_for_session",
        fallbackText: "2",
        id: "approval:accept_for_session",
        label: "Approve for Session",
        responseDecision: "accept_for_session",
        style: "secondary",
      }),
      buildAction({
        decision: "decline",
        fallbackText: "3",
        id: "approval:decline",
        label: "Decline",
        responseDecision: "decline",
        style: "danger",
      }),
      buildAction({
        decision: "cancel",
        fallbackText: "4",
        id: "approval:cancel",
        label: "Cancel Turn",
        responseDecision: "cancel",
        style: "secondary",
      }),
    ];
  }

  if (request.method.includes("fileChange/requestApproval")) {
    return [
      buildAction({
        decision: "accept",
        fallbackText: "1",
        id: "approval:accept",
        label: "Approve Once",
        responseDecision: "accept",
        style: "primary",
      }),
      buildAction({
        decision: "decline",
        fallbackText: "2",
        id: "approval:decline",
        label: "Decline",
        responseDecision: "decline",
        style: "danger",
      }),
      buildAction({
        decision: "cancel",
        fallbackText: "3",
        id: "approval:cancel",
        label: "Cancel Turn",
        responseDecision: "cancel",
        style: "secondary",
      }),
    ];
  }

  return [
    buildAction({
      decision: "accept",
      fallbackText: "1",
      id: "approval:accept",
      label: "Approve Once",
      responseDecision: "approve",
      style: "primary",
    }),
    buildAction({
      decision: "decline",
      fallbackText: "2",
      id: "approval:decline",
      label: "Decline",
      responseDecision: "decline",
      style: "danger",
    }),
    buildAction({
      decision: "cancel",
      fallbackText: "3",
      id: "approval:cancel",
      label: "Cancel Turn",
      responseDecision: "cancel",
      style: "secondary",
    }),
  ];
}

function buildAction(params: {
  decision: PendingRequestActionDecision;
  fallbackText: string;
  id: string;
  label: string;
  responseDecision: unknown;
  style: PendingRequestActionStyle;
}): PendingRequestAction {
  return {
    id: params.id,
    label: params.label,
    decision: params.decision,
    style: params.style,
    fallbackText: params.fallbackText,
    response: { decision: params.responseDecision },
  };
}

function normalizeDecision(
  value: string,
): PendingRequestActionDecision | undefined {
  const normalized = value.trim().toLowerCase().replace(/[-_\s]/g, "");
  if (
    ["acceptforsession", "approveforsession", "allowforsession"].includes(
      normalized,
    )
  ) {
    return "accept_for_session";
  }
  if (
    [
      "acceptwithexecpolicyamendment",
      "approvewithexecpolicyamendment",
      "acceptwithcommandprefix",
    ].includes(normalized)
  ) {
    return "accept_with_execpolicy_amendment";
  }
  if (
    ["applynetworkpolicyamendment", "networkpolicyamendment"].includes(
      normalized,
    )
  ) {
    return "apply_network_policy_amendment";
  }
  if (
    [
      "accept",
      "acceptonce",
      "approve",
      "approveonce",
      "allow",
      "allowonce",
      "yes",
    ].includes(normalized)
  ) {
    return "accept";
  }
  if (["decline", "deny", "reject", "no"].includes(normalized)) {
    return "decline";
  }
  if (["cancel", "abort", "stop"].includes(normalized)) {
    return "cancel";
  }
  return undefined;
}

function legacyOptionResponseDecision(rawDecision: string): string {
  return normalizeDecision(rawDecision) ?? rawDecision;
}

function defaultLabel(
  request: AppServerPendingRequestNotification,
  decision: PendingRequestActionDecision,
): string {
  switch (decision) {
    case "accept":
      return "Approve Once";
    case "accept_for_session":
      return hasNetworkApprovalContext(request)
        ? "Allow for Conversation"
        : "Approve for Session";
    case "accept_with_execpolicy_amendment":
      return "Approve Command Prefix";
    case "apply_network_policy_amendment":
      return "Apply Network Rule";
    case "decline":
      return "Decline";
    case "cancel":
      return "Cancel Turn";
  }
}

function defaultStyle(decision: PendingRequestActionDecision): PendingRequestActionStyle {
  switch (decision) {
    case "accept":
    case "accept_with_execpolicy_amendment":
    case "apply_network_policy_amendment":
      return "primary";
    case "decline":
      return "danger";
    case "accept_for_session":
    case "cancel":
      return "secondary";
  }
}

function execpolicyLabel(payload: object): string {
  const record = payload as Record<string, unknown>;
  const prefix = record.execpolicy_amendment ?? record.proposed_execpolicy_amendment;
  const command = Array.isArray(prefix)
    ? prefix.filter((part): part is string => typeof part === "string")
    : undefined;
  const rendered = command?.join(" ").trim();
  return rendered ? `Approve Prefix: ${rendered}` : "Approve Command Prefix";
}

function networkPolicyLabel(payload: object): string {
  const amendment = (payload as Record<string, unknown>).network_policy_amendment;
  const record =
    amendment && typeof amendment === "object"
      ? (amendment as Record<string, unknown>)
      : undefined;
  const action = readString(record?.action)?.toLowerCase();
  const host = readString(record?.host);
  if (action === "deny") {
    return host ? `Block ${host}` : "Block Host";
  }
  return host ? `Allow ${host}` : "Allow Host";
}

function hasNetworkApprovalContext(
  request: AppServerPendingRequestNotification,
): boolean {
  return Boolean(
    request.params.network_approval_context ??
      request.params.networkApprovalContext,
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
