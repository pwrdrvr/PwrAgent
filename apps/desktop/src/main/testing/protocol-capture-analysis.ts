import fs from "node:fs/promises";
import path from "node:path";
import type { ProtocolCaptureEventRecord } from "./capture-store";

export type ProtocolCaptureMethodSummary = {
  count: number;
  callerReasons: string[];
  firstAt?: number;
  lastAt?: number;
  ownerIds: string[];
};

export type ProtocolCaptureBackendSummary = {
  requestCounts: Record<string, number>;
  notificationCounts: Record<string, number>;
  responseCounts: Record<string, number>;
  requests: Record<string, ProtocolCaptureMethodSummary>;
};

export type ProtocolCaptureTrafficAnalysis = {
  backendInstances: string[];
  captureIds: string[];
  capturePath: string;
  malformedRecordCount: number;
  summaries: Record<string, ProtocolCaptureBackendSummary>;
};

export async function analyzeProtocolCaptureTraffic(params: {
  capturePath: string;
}): Promise<ProtocolCaptureTrafficAnalysis> {
  const capturePath = path.resolve(params.capturePath);
  const contents = await fs.readFile(capturePath, "utf8");
  const captureIds = new Set<string>();
  const backendInstances = new Set<string>();
  const summaries = new Map<string, MutableBackendSummary>();
  let malformedRecordCount = 0;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const record = parseCaptureRecord(line);
    if (!record) {
      malformedRecordCount += 1;
      continue;
    }

    captureIds.add(record.captureId);
    if (record.backendInstance) {
      backendInstances.add(`${record.backend}:${record.backendInstance}`);
    } else {
      backendInstances.add(record.backend);
    }

    const summary = getMutableSummary(summaries, record.backend);
    const method = record.method?.trim() || inferResponseMethod(record) || "unknown";
    if (record.kind === "request" && record.direction === "outbound") {
      increment(summary.requestCounts, method);
      const methodSummary = getMutableMethodSummary(summary.requests, method);
      methodSummary.count += 1;
      methodSummary.firstAt =
        methodSummary.firstAt === undefined
          ? record.timestamp
          : Math.min(methodSummary.firstAt, record.timestamp);
      methodSummary.lastAt =
        methodSummary.lastAt === undefined
          ? record.timestamp
          : Math.max(methodSummary.lastAt, record.timestamp);
      const callerReason = record.diagnostics?.callerReason?.trim();
      if (callerReason) {
        methodSummary.callerReasons.add(callerReason);
      }
      const ownerId = record.diagnostics?.ownerId?.trim();
      if (ownerId) {
        methodSummary.ownerIds.add(ownerId);
      }
      continue;
    }

    if (record.kind === "notification") {
      increment(summary.notificationCounts, method);
      continue;
    }

    if (record.kind === "response") {
      increment(summary.responseCounts, method);
    }
  }

  return {
    backendInstances: [...backendInstances].sort(),
    captureIds: [...captureIds].sort(),
    capturePath,
    malformedRecordCount,
    summaries: Object.fromEntries(
      [...summaries.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([backend, summary]) => [backend, finalizeSummary(summary)]),
    ),
  };
}

type MutableMethodSummary = {
  count: number;
  callerReasons: Set<string>;
  firstAt?: number;
  lastAt?: number;
  ownerIds: Set<string>;
};

type MutableBackendSummary = {
  requestCounts: Record<string, number>;
  notificationCounts: Record<string, number>;
  responseCounts: Record<string, number>;
  requests: Map<string, MutableMethodSummary>;
};

function parseCaptureRecord(line: string): ProtocolCaptureEventRecord | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as ProtocolCaptureEventRecord;
    if (
      typeof record.backend !== "string" ||
      !record.backend.trim() ||
      !record.captureId?.trim() ||
      (record.direction !== "inbound" && record.direction !== "outbound") ||
      (record.kind !== "request" &&
        record.kind !== "response" &&
        record.kind !== "notification") ||
      typeof record.timestamp !== "number"
    ) {
      return null;
    }

    return record;
  } catch {
    return null;
  }
}

function inferResponseMethod(record: ProtocolCaptureEventRecord): string | undefined {
  if (record.kind !== "response") {
    return undefined;
  }
  return record.method?.trim() || undefined;
}

function getMutableSummary(
  summaries: Map<string, MutableBackendSummary>,
  backend: string,
): MutableBackendSummary {
  const existing = summaries.get(backend);
  if (existing) {
    return existing;
  }

  const created: MutableBackendSummary = {
    requestCounts: {},
    notificationCounts: {},
    responseCounts: {},
    requests: new Map(),
  };
  summaries.set(backend, created);
  return created;
}

function getMutableMethodSummary(
  summaries: Map<string, MutableMethodSummary>,
  method: string,
): MutableMethodSummary {
  const existing = summaries.get(method);
  if (existing) {
    return existing;
  }

  const created: MutableMethodSummary = {
    count: 0,
    callerReasons: new Set(),
    ownerIds: new Set(),
  };
  summaries.set(method, created);
  return created;
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function finalizeSummary(summary: MutableBackendSummary): ProtocolCaptureBackendSummary {
  return {
    requestCounts: sortCounts(summary.requestCounts),
    notificationCounts: sortCounts(summary.notificationCounts),
    responseCounts: sortCounts(summary.responseCounts),
    requests: Object.fromEntries(
      [...summary.requests.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([method, methodSummary]) => [
          method,
          {
            count: methodSummary.count,
            callerReasons: [...methodSummary.callerReasons].sort(),
            firstAt: methodSummary.firstAt,
            lastAt: methodSummary.lastAt,
            ownerIds: [...methodSummary.ownerIds].sort(),
          },
        ]),
    ),
  };
}

function sortCounts(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}
