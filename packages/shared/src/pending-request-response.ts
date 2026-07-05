import type {
  AppServerPendingRequestNotification,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadFileDiffRef,
} from "./contracts/normalized-app-server";

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

export type PendingRequestApprovalContext = {
  action?: string;
  diff?: string;
  displayGrantRoot?: string;
  displayPath?: string;
  files?: PendingRequestApprovalFileContext[];
  grantRoot?: string;
  path?: string;
};

export type PendingRequestApprovalFileContext = {
  action?: string;
  additions?: number;
  diff?: string;
  diffRef?: AppServerThreadFileDiffRef;
  diffRefs?: AppServerThreadFileDiffRef[];
  displayPath: string;
  omittedReason?: string;
  path: string;
  removals?: number;
};

export function buildPendingRequestApprovalContext(
  request: AppServerPendingRequestNotification,
  options: { directoryPaths?: string[]; entries?: AppServerThreadEntry[] } = {},
): PendingRequestApprovalContext | undefined {
  const params = request.params;
  const embeddedFiles = readEmbeddedApprovalFiles(
    params,
    options.directoryPaths,
  );
  const requestFiles = embeddedFiles.length
    ? []
    : readRequestApprovalFiles(params, options.directoryPaths);
  const inferredFiles = embeddedFiles.length
    ? embeddedFiles
    : requestFiles.length
      ? requestFiles
      : inferFileChangeApprovalFiles(request, options);
  const path = readFirstString(params, [
    "path",
    "filePath",
    "file_path",
    "filename",
    "file",
    "targetPath",
    "target_path",
  ]);
  const grantRoot = readFirstString(params, [
    "grantRoot",
    "grant_root",
    "writeRoot",
    "write_root",
  ]);
  const action = readFirstString(params, ["action", "operation"]);
  const diff = readFirstString(params, [
    "diff",
    "patch",
    "unifiedDiff",
    "unified_diff",
  ]);
  const primaryFile = inferredFiles[0];
  const resolvedPath = path ?? primaryFile?.path;
  const resolvedAction = action ?? primaryFile?.action;
  const resolvedDiff = diff ?? primaryFile?.diff;
  const hasSubject = Boolean(
    resolvedPath || grantRoot || resolvedDiff || inferredFiles.length,
  );

  const context: PendingRequestApprovalContext = {
    ...(hasSubject && resolvedAction ? { action: resolvedAction } : {}),
    ...(resolvedPath
      ? {
          path: resolvedPath,
          displayPath: formatApprovalPath(resolvedPath, options.directoryPaths),
        }
      : {}),
    ...(inferredFiles.length ? { files: inferredFiles } : {}),
    ...(grantRoot
      ? {
          grantRoot,
          displayGrantRoot: formatApprovalPath(
            grantRoot,
            options.directoryPaths,
          ),
        }
      : {}),
    ...(resolvedDiff ? { diff: resolvedDiff } : {}),
  };

  return Object.keys(context).length > 0 ? context : undefined;
}

function inferFileChangeApprovalFiles(
  request: AppServerPendingRequestNotification,
  options: { directoryPaths?: string[]; entries?: AppServerThreadEntry[] },
): PendingRequestApprovalFileContext[] {
  if (!request.method.includes("fileChange/requestApproval")) {
    return [];
  }

  const entries = options.entries ?? [];
  if (!entries.length) {
    return [];
  }

  const itemId = readFirstString(request.params, [
    "itemId",
    "item_id",
    "callId",
    "call_id",
  ]);
  const turnId = readString(request.params.turnId);
  const activities = entries
    .filter(
      (entry): entry is AppServerThreadActivityEntry =>
        entry.type === "activity",
    )
    .filter((entry) => !turnId || entry.turn?.id === turnId);
  const matchingActivities = itemId
    ? activities.filter((entry) => activityMatchesItem(entry, itemId))
    : [];
  const sourceActivities = matchingActivities.length
    ? matchingActivities
    : activities
        .filter((entry) =>
          entry.details.some((detail) => detail.kind === "write"),
        )
        .slice(-1);

  const files = sourceActivities.flatMap((entry) =>
    entry.details
      .filter((detail) => detail.kind === "write")
      .filter(
        (detail) =>
          !itemId
          || detailMatchesItem(detail, itemId)
          || !matchingActivities.length,
      )
      .map((detail) =>
        fileContextFromActivityDetail(detail, options.directoryPaths),
      )
      .filter((file): file is PendingRequestApprovalFileContext =>
        Boolean(file),
      ),
  );

  return dedupeApprovalFiles(files);
}

function readEmbeddedApprovalFiles(
  params: Record<string, unknown>,
  directoryPaths: string[] | undefined,
): PendingRequestApprovalFileContext[] {
  const context =
    asRecord(params._pwragentApprovalContext)
    ?? asRecord(params.approvalContext)
    ?? asRecord(params.fileChangeContext);
  const rawFiles = context?.files;
  if (!Array.isArray(rawFiles)) {
    return [];
  }

  return dedupeApprovalFiles(
    rawFiles
      .map((entry) => {
        const record = asRecord(entry);
        return fileContextFromApprovalRecord(record, directoryPaths);
      })
      .filter((file): file is PendingRequestApprovalFileContext =>
        Boolean(file),
      ),
  );
}

function readRequestApprovalFiles(
  params: Record<string, unknown>,
  directoryPaths: string[] | undefined,
): PendingRequestApprovalFileContext[] {
  const item = asRecord(params.item);
  const rawFiles = [
    params.files,
    params.fileChanges,
    params.file_changes,
    params.changes,
    item?.changes,
  ]
    .filter((entry): entry is unknown[] => Array.isArray(entry))
    .flat();
  if (!rawFiles.length) {
    return [];
  }

  return dedupeApprovalFiles(
    rawFiles
      .map((entry) =>
        fileContextFromApprovalRecord(asRecord(entry), directoryPaths),
      )
      .filter((file): file is PendingRequestApprovalFileContext =>
        Boolean(file),
      ),
  );
}

function fileContextFromApprovalRecord(
  record: Record<string, unknown> | undefined,
  directoryPaths: string[] | undefined,
): PendingRequestApprovalFileContext | undefined {
  const path = readFirstString(record ?? {}, [
    "path",
    "filePath",
    "file_path",
    "filename",
    "file",
    "targetPath",
    "target_path",
  ]);
  if (!record || !path) {
    return undefined;
  }

  const kind = asRecord(record.kind);
  const action =
    readFirstString(kind ?? {}, ["type", "action", "operation"])
    ?? readFirstString(record, ["action", "operation", "kind", "type"]);
  const directDiff =
    readFirstString(kind ?? {}, [
      "diff",
      "patch",
      "unifiedDiff",
      "unified_diff",
    ])
    ?? readFirstString(record, [
      "diff",
      "patch",
      "unifiedDiff",
      "unified_diff",
    ]);
  const content =
    readOptionalString(kind?.content) ?? readOptionalString(record.content);
  const generatedDiff =
    directDiff ?? contentDiffForApproval({ action, content, path });

  return {
    ...(action ? { action } : {}),
    ...(readNumber(record.additions) !== undefined
      ? { additions: readNumber(record.additions) }
      : {}),
    ...(generatedDiff ? { diff: generatedDiff } : {}),
    ...readDiffRefFields(record),
    displayPath: formatApprovalPath(
      readString(record.displayPath) ?? path,
      directoryPaths,
    ),
    ...(readString(record.omittedReason)
      ? { omittedReason: readString(record.omittedReason) }
      : {}),
    path,
    ...(readNumber(record.removals) !== undefined
      ? { removals: readNumber(record.removals) }
      : {}),
  };
}

function contentDiffForApproval(params: {
  action: string | undefined;
  content: string | undefined;
  path: string;
}): string | undefined {
  if (
    params.content === undefined
    || (params.action !== "add" && params.action !== "delete")
  ) {
    return undefined;
  }
  const path = params.path.replace(/^\/+/, "") || "file";
  const lines = params.content.length ? params.content.split("\n") : [];
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const hunkLineCount = lines.length;
  const header =
    params.action === "add"
      ? [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${hunkLineCount} @@`]
      : [`--- a/${path}`, `+++ /dev/null`, `@@ -1,${hunkLineCount} +0,0 @@`];
  const prefix = params.action === "add" ? "+" : "-";
  return [...header, ...lines.map((line) => `${prefix}${line}`)].join("\n");
}

function activityMatchesItem(
  entry: AppServerThreadActivityEntry,
  itemId: string,
): boolean {
  return (
    entry.id === itemId
    || entry.id === `activity-${itemId}`
    || entry.details.some((detail) => detailMatchesItem(detail, itemId))
  );
}

function detailMatchesItem(
  detail: AppServerThreadActivityDetail,
  itemId: string,
): boolean {
  return detail.id === itemId || detail.id.startsWith(`${itemId}-`);
}

function fileContextFromActivityDetail(
  detail: AppServerThreadActivityDetail,
  directoryPaths: string[] | undefined,
): PendingRequestApprovalFileContext | undefined {
  const path = readString(detail.path);
  if (!path) {
    return undefined;
  }
  return {
    action: detail.fileDiff?.kind,
    additions: detail.fileDiff?.additions,
    diff: detail.fileDiff?.diff,
    diffRef: detail.fileDiff?.diffRef,
    diffRefs: detail.fileDiff?.diffRefs,
    displayPath: formatApprovalPath(path, directoryPaths),
    omittedReason: detail.fileDiff?.omittedReason,
    path,
    removals: detail.fileDiff?.removals,
  };
}

function dedupeApprovalFiles(
  files: PendingRequestApprovalFileContext[],
): PendingRequestApprovalFileContext[] {
  const seen = new Set<string>();
  const result: PendingRequestApprovalFileContext[] = [];
  for (const file of files) {
    const key = `${file.path}\0${file.diff ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(file);
  }
  return result;
}

export function formatApprovalPath(
  value: string,
  directoryPaths: string[] | undefined,
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const roots = [...(directoryPaths ?? [])]
    .map((root) => normalizePath(root))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const normalizedValue = normalizePath(trimmed);

  for (const root of roots) {
    if (normalizedValue === root) {
      return ".";
    }
    if (normalizedValue.startsWith(`${root}/`)) {
      return normalizedValue.slice(root.length + 1) || ".";
    }
  }

  return trimmed;
}

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
    readDecisionEntries(request.params.availableDecisions)
    ?? readDecisionEntries(request.params.decisions);
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
      actions.find((action) => action.decision === "accept")
      ?? actions.find(
        (action) =>
          (action.decision === "accept_for_session"
            || action.decision === "accept_with_execpolicy_amendment"
            || action.decision === "apply_network_policy_amendment")
          && action.style !== "danger",
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
    record.acceptWithExecpolicyAmendment
    ?? record.accept_with_execpolicy_amendment;
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
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[-_\s]/g, "");
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

function defaultStyle(
  decision: PendingRequestActionDecision,
): PendingRequestActionStyle {
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
  const prefix =
    record.execpolicy_amendment ?? record.proposed_execpolicy_amendment;
  const command = Array.isArray(prefix)
    ? prefix.filter((part): part is string => typeof part === "string")
    : undefined;
  const rendered = command?.join(" ").trim();
  return rendered
    ? `Always Allow Prefix: ${rendered}`
    : "Always Allow Command Prefix";
}

function networkPolicyLabel(payload: object): string {
  const amendment = (payload as Record<string, unknown>)
    .network_policy_amendment;
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
    request.params.network_approval_context
    ?? request.params.networkApprovalContext,
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readDiffRefFields(
  record: Record<string, unknown> | undefined,
): Pick<PendingRequestApprovalFileContext, "diffRef" | "diffRefs"> {
  if (!record) {
    return {};
  }
  const diffRef = readDiffRef(record.diffRef);
  const diffRefs = Array.isArray(record.diffRefs)
    ? record.diffRefs
        .map((entry) => readDiffRef(entry))
        .filter((entry): entry is AppServerThreadFileDiffRef => Boolean(entry))
    : undefined;
  return {
    ...(diffRef ? { diffRef } : {}),
    ...(diffRefs?.length ? { diffRefs } : {}),
  };
}

function readDiffRef(value: unknown): AppServerThreadFileDiffRef | undefined {
  const record = asRecord(value);
  const source = readString(record?.source);
  const key = readString(record?.key);
  const threadId = readString(record?.threadId);
  const entryId = readString(record?.entryId);
  const detailId = readString(record?.detailId);
  if (
    (source !== "live" && source !== "thread")
    || !key
    || !threadId
    || !entryId
    || !detailId
  ) {
    return undefined;
  }
  const backend = readDiffRefBackend(record?.backend);
  return {
    source,
    key,
    threadId,
    entryId,
    detailId,
    ...(backend ? { backend } : {}),
  };
}

function readDiffRefBackend(
  value: unknown,
): AppServerThreadFileDiffRef["backend"] | undefined {
  const backend = readString(value);
  if (
    backend === "codex"
    || backend === "grok"
    || backend?.startsWith("acp:")
  ) {
    return backend as AppServerThreadFileDiffRef["backend"];
  }
  return undefined;
}

function readFirstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}
