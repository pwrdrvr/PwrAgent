import path from "node:path";
import {
  readProtocolCaptureFile,
  type CapturedProtocolEnvelopeRecord,
  type ProtocolCaptureEnvelope,
} from "./capture-store";

type ThreadListRequestVariant = {
  method: "thread/list" | "thread/loaded/list";
  paramsKeys: string[];
  archived?: boolean;
  limit?: number;
  filterKey?: "searchTerm" | "query" | "filter";
};

type ThreadListSample = {
  id: string;
  cwd?: string;
  projectKey?: string;
  path?: string;
  gitBranch?: string;
  statusType?: string;
};

type ThreadIdentityFieldCounts = {
  cwd: number;
  sessionCwd: number;
  projectKey: number;
  path: number;
  gitBranch: number;
  status: number;
};

export type CodexThreadProtocolAnalysis = {
  capturePath: string;
  captureId?: string;
  requestCounts: Record<string, number>;
  notificationCounts: Record<string, number>;
  threadList: {
    requestMethods: Array<"thread/list" | "thread/loaded/list">;
    requestVariants: ThreadListRequestVariant[];
    responseContainerKeys: string[];
    responseResultKeys: string[];
    activeRequestCount: number;
    archivedRequestCount: number;
    identityFieldCounts: ThreadIdentityFieldCounts;
    sampleThreads: ThreadListSample[];
  };
  threadRead: {
    requestCount: number;
    includeTurnsVariants: boolean[];
  };
};

export async function analyzeCodexThreadProtocolCapture(params: {
  capturePath: string;
}): Promise<CodexThreadProtocolAnalysis> {
  const capturePath = path.resolve(params.capturePath);
  const records = await readProtocolCaptureFile(capturePath);
  const requestsById = buildRequestIndex(records);

  const requestCounts: Record<string, number> = {};
  const notificationCounts: Record<string, number> = {};
  const requestVariants = new Map<string, ThreadListRequestVariant>();
  const responseContainerKeys = new Set<string>();
  const responseResultKeys = new Set<string>();
  const requestMethods = new Set<"thread/list" | "thread/loaded/list">();
  const identityFieldCounts: ThreadIdentityFieldCounts = {
    cwd: 0,
    sessionCwd: 0,
    projectKey: 0,
    path: 0,
    gitBranch: 0,
    status: 0,
  };
  const sampleThreads = new Map<string, ThreadListSample>();
  let activeRequestCount = 0;
  let archivedRequestCount = 0;
  let threadReadRequestCount = 0;
  const includeTurnsVariants = new Set<boolean>();

  for (const entry of records) {
    const method = entry.envelope.method?.trim();
    if (entry.record.direction === "outbound" && entry.record.kind === "request" && method) {
      requestCounts[method] = (requestCounts[method] ?? 0) + 1;

      if (method === "thread/list" || method === "thread/loaded/list") {
        requestMethods.add(method);
        const paramsRecord = asRecord(entry.envelope.params);
        const archived = typeof paramsRecord?.archived === "boolean" ? paramsRecord.archived : undefined;
        if (archived === true) {
          archivedRequestCount += 1;
        } else if (archived === false) {
          activeRequestCount += 1;
        }

        const filterKey = (["searchTerm", "query", "filter"] as const).find(
          (key) => typeof paramsRecord?.[key] === "string" && String(paramsRecord[key]).trim(),
        );
        const variant: ThreadListRequestVariant = {
          method,
          paramsKeys: Object.keys(paramsRecord ?? {}).sort(),
          ...(archived !== undefined ? { archived } : {}),
          ...(typeof paramsRecord?.limit === "number" ? { limit: paramsRecord.limit } : {}),
          ...(filterKey ? { filterKey } : {}),
        };
        requestVariants.set(JSON.stringify(variant), variant);
      }

      if (method === "thread/read") {
        threadReadRequestCount += 1;
        const paramsRecord = asRecord(entry.envelope.params);
        includeTurnsVariants.add(Boolean(paramsRecord?.includeTurns));
      }
      continue;
    }

    if (entry.record.direction === "inbound" && entry.record.kind === "notification" && method) {
      notificationCounts[method] = (notificationCounts[method] ?? 0) + 1;
      continue;
    }

    if (entry.record.direction !== "inbound" || entry.record.kind !== "response") {
      continue;
    }

    const responseMethod = lookupMethodForResponse(requestsById, entry.envelope);
    if (responseMethod !== "thread/list" && responseMethod !== "thread/loaded/list") {
      continue;
    }

    requestMethods.add(responseMethod);
    const resultRecord = asRecord(entry.envelope.result);
    if (resultRecord) {
      for (const key of Object.keys(resultRecord).sort()) {
        responseResultKeys.add(key);
      }
    }

    const extracted = extractThreadRecords(entry.envelope.result);
    for (const container of extracted) {
      responseContainerKeys.add(container.containerKey);

      for (const record of container.records) {
        accumulateIdentityFields(record, identityFieldCounts);

        const threadId = pickString(record, ["id", "threadId", "thread_id"]);
        if (!threadId || sampleThreads.has(threadId) || sampleThreads.size >= 8) {
          continue;
        }

        sampleThreads.set(threadId, {
          id: threadId,
          cwd:
            pickString(record, ["cwd"]) ?? pickString(asRecord(record.session) ?? {}, ["cwd"]),
          projectKey:
            pickString(record, ["projectKey", "project_key"]) ??
            pickString(asRecord(record.session) ?? {}, ["projectKey", "project_key"]),
          path: pickString(record, ["path"]),
          gitBranch:
            pickString(asRecord(record.gitInfo) ?? {}, ["branch"]) ??
            pickString(asRecord(record.git_info) ?? {}, ["branch"]) ??
            pickString(asRecord(asRecord(record.session)?.gitInfo) ?? {}, ["branch"]),
          statusType: pickString(asRecord(record.status) ?? {}, ["type"]),
        });
      }
    }
  }

  return {
    capturePath,
    captureId: records[0]?.record.captureId,
    requestCounts: sortRecord(requestCounts),
    notificationCounts: sortRecord(notificationCounts),
    threadList: {
      requestMethods: [...requestMethods].sort(),
      requestVariants: [...requestVariants.values()].sort(compareRequestVariants),
      responseContainerKeys: [...responseContainerKeys].sort(),
      responseResultKeys: [...responseResultKeys].sort(),
      activeRequestCount,
      archivedRequestCount,
      identityFieldCounts,
      sampleThreads: [...sampleThreads.values()],
    },
    threadRead: {
      requestCount: threadReadRequestCount,
      includeTurnsVariants: [...includeTurnsVariants].sort(),
    },
  };
}

function buildRequestIndex(
  records: CapturedProtocolEnvelopeRecord[],
): Map<string, string> {
  const requestsById = new Map<string, string>();
  for (const entry of records) {
    const method = entry.envelope.method?.trim();
    if (
      entry.record.direction === "outbound" &&
      entry.record.kind === "request" &&
      method &&
      entry.envelope.id !== null &&
      entry.envelope.id !== undefined
    ) {
      requestsById.set(String(entry.envelope.id), method);
    }
  }
  return requestsById;
}

function lookupMethodForResponse(
  requestsById: Map<string, string>,
  envelope: ProtocolCaptureEnvelope,
): string | undefined {
  if (envelope.id === null || envelope.id === undefined) {
    return undefined;
  }
  return requestsById.get(String(envelope.id));
}

function compareRequestVariants(
  left: ThreadListRequestVariant,
  right: ThreadListRequestVariant,
): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function sortRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function looksLikeThreadRecord(record: Record<string, unknown>): boolean {
  if (!pickString(record, ["id", "threadId", "thread_id"])) {
    return false;
  }

  return [
    "cwd",
    "path",
    "projectKey",
    "project_key",
    "gitInfo",
    "git_info",
    "preview",
    "name",
    "title",
    "updatedAt",
    "updated_at",
  ].some((key) => key in record);
}

function isThreadRecord(value: Record<string, unknown> | null): value is Record<string, unknown> {
  return value !== null && looksLikeThreadRecord(value);
}

function extractThreadRecords(value: unknown): Array<{
  containerKey: string;
  records: Record<string, unknown>[];
}> {
  const resultRecord = asRecord(value);
  if (!resultRecord) {
    return [];
  }

  const output: Array<{ containerKey: string; records: Record<string, unknown>[] }> = [];
  for (const containerKey of ["data", "threads", "results", "items"]) {
    const container = resultRecord[containerKey];
    if (!Array.isArray(container)) {
      continue;
    }

    const records = container.map((entry) => asRecord(entry)).filter(isThreadRecord);
    if (records.length > 0) {
      output.push({
        containerKey,
        records,
      });
    }
  }

  if (output.length === 0 && Array.isArray(value)) {
    const records = value.map((entry) => asRecord(entry)).filter(isThreadRecord);
    if (records.length > 0) {
      output.push({
        containerKey: "root",
        records,
      });
    }
  }

  return output;
}

function accumulateIdentityFields(
  record: Record<string, unknown>,
  counts: ThreadIdentityFieldCounts,
): void {
  const sessionRecord = asRecord(record.session);
  if (pickString(record, ["cwd"])) {
    counts.cwd += 1;
  }
  if (pickString(sessionRecord ?? {}, ["cwd"])) {
    counts.sessionCwd += 1;
  }
  if (pickString(record, ["projectKey", "project_key"])) {
    counts.projectKey += 1;
  }
  if (pickString(record, ["path"])) {
    counts.path += 1;
  }
  if (
    pickString(asRecord(record.gitInfo) ?? {}, ["branch"]) ||
    pickString(asRecord(record.git_info) ?? {}, ["branch"]) ||
    pickString(asRecord(sessionRecord?.gitInfo) ?? {}, ["branch"]) ||
    pickString(asRecord(sessionRecord?.git_info) ?? {}, ["branch"])
  ) {
    counts.gitBranch += 1;
  }
  if (pickString(asRecord(record.status) ?? {}, ["type"])) {
    counts.status += 1;
  }
}
