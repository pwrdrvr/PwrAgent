import fs from "node:fs/promises";
import path from "node:path";
import type { AppServerNotification } from "@pwragent/shared";
import {
  readProtocolCaptureFile,
  type CapturedProtocolEnvelopeRecord,
  type ProtocolCaptureEnvelope,
  type ProtocolCaptureEventRecord,
  type ProtocolCaptureStringReplacement,
} from "./capture-store";
import type {
  ReplayFixture,
  ReplayRequestStep,
  ReplayResponseStep,
  ReplayStep,
} from "./replay-fixture";
import { validateReplayFixture } from "./replay-fixture";

type CaptureIndexEntry = {
  backend: string;
  captureId: string;
  createdAt: number;
  path: string;
  threadIds: string[];
  updatedAt: number;
};

type CapturedEnvelopeRecord = {
  record: ProtocolCaptureEventRecord;
  envelope: ProtocolCaptureEnvelope;
};

export type StringReplacement = ProtocolCaptureStringReplacement;

export type DeriveReplayFixtureOptions = {
  capturePath: string;
  scenario: string;
  backend?: "codex" | "grok";
  sourceCaptureId?: string;
  threadId?: string;
  startSequence?: number;
  endSequence?: number;
  stepLabels?: Record<number, string>;
  redactions?: StringReplacement[];
};

export type DerivedReplayFixtureArtifacts = {
  fixture: ReplayFixture;
  rawCaptureRecords: ProtocolCaptureEventRecord[];
};

export type WriteReplayFixtureArtifactsOptions = {
  outputDir: string;
  fixture: ReplayFixture;
  rawCaptureRecords: ProtocolCaptureEventRecord[];
};

export type ExportSessionCaptureOptions = {
  captureRoot: string;
  outputPath: string;
  captureId?: string;
  sessionId?: string;
  threadId?: string;
  backend?: "codex" | "grok";
};

export type ExportedSessionCapture = {
  captureId: string;
  sourcePath: string;
  outputPath: string;
};

export async function deriveReplayFixtureFromCapture(
  options: DeriveReplayFixtureOptions
): Promise<DerivedReplayFixtureArtifacts> {
  const allRecords = await readProtocolCaptureFile(
    options.capturePath,
    options.redactions ?? []
  );
  const threadScopedRecords = filterCaptureRecordsByThread(
    allRecords,
    options.threadId
  );
  const selectedRecords = selectCaptureWindow(threadScopedRecords, options);
  if (selectedRecords.length === 0) {
    throw new Error(
      `No capture records selected from ${options.capturePath}`
    );
  }

  const requestsById = new Map<string, CapturedEnvelopeRecord>();
  for (const entry of threadScopedRecords) {
    if (
      entry.record.direction === "outbound"
      && entry.record.kind === "request"
      && entry.envelope.id != null
      && entry.envelope.method?.trim()
    ) {
      requestsById.set(String(entry.envelope.id), entry);
    }
  }

  const stepCounts = new Map<string, number>();
  const steps: ReplayStep[] = [];
  for (const entry of selectedRecords) {
    if (entry.record.direction !== "inbound") {
      continue;
    }

    if (entry.record.kind === "response") {
      const requestId =
        entry.envelope.id === null || entry.envelope.id === undefined
          ? undefined
          : String(entry.envelope.id);
      if (!requestId) {
        throw new Error(
          `Response capture record ${entry.record.sequence} is missing an id`
        );
      }

      const requestEntry = requestsById.get(requestId);
      if (!requestEntry?.envelope.method?.trim()) {
        throw new Error(
          `Could not match response sequence ${entry.record.sequence} to an outbound request`
        );
      }

      const responseStep: ReplayResponseStep = {
        id: getStepId({
          sequence: entry.record.sequence,
          base: requestEntry.envelope.method,
          counts: stepCounts,
          labels: options.stepLabels,
        }),
        kind: "response",
        method: requestEntry.envelope.method,
      };
      if (Object.hasOwn(entry.envelope, "result")) {
        responseStep.result = entry.envelope.result;
      }
      if (entry.envelope.error) {
        responseStep.error = entry.envelope.error;
      }
      steps.push(responseStep);
      continue;
    }

    if (!entry.envelope.method?.trim()) {
      throw new Error(
        `Inbound capture record ${entry.record.sequence} is missing method`
      );
    }

    if (entry.record.kind === "notification") {
      steps.push({
        id: getStepId({
          sequence: entry.record.sequence,
          base: entry.envelope.method,
          counts: stepCounts,
          labels: options.stepLabels,
        }),
        kind: "notification",
        notification: {
          method: entry.envelope.method as AppServerNotification["method"],
          params: (entry.envelope.params ?? {}) as Record<string, unknown>,
        } as AppServerNotification,
      });
      continue;
    }

    const requestStep: ReplayRequestStep = {
      id: getStepId({
        sequence: entry.record.sequence,
        base: entry.envelope.method,
        counts: stepCounts,
        labels: options.stepLabels,
      }),
      kind: "request",
      request: {
        method: entry.envelope.method,
        params: (entry.envelope.params ?? {}) as ReplayRequestStep["request"]["params"],
      },
    };
    steps.push(requestStep);
  }

  const fixture: ReplayFixture = {
    metadata: {
      backend:
        options.backend ??
        toReplayBackend(selectedRecords[0]?.record.backend) ??
        "codex",
      scenario: options.scenario,
      sourceCaptureId:
        options.sourceCaptureId ?? selectedRecords[0]?.record.captureId,
      threadId: options.threadId ?? inferThreadId(selectedRecords),
    },
    steps,
  };
  if (!fixture.metadata.threadId) {
    delete fixture.metadata.threadId;
  }
  if (!fixture.metadata.sourceCaptureId) {
    delete fixture.metadata.sourceCaptureId;
  }

  validateReplayFixture(fixture);

  return {
    fixture,
    rawCaptureRecords: selectedRecords.map((entry) => entry.record),
  };
}

function toReplayBackend(value: string | undefined): "codex" | "grok" | undefined {
  return value === "codex" || value === "grok" ? value : undefined;
}

export async function writeReplayFixtureArtifacts(
  options: WriteReplayFixtureArtifactsOptions
): Promise<{
  fixturePath: string;
  rawCapturePath: string;
}> {
  await fs.mkdir(options.outputDir, { recursive: true });

  const fixturePath = path.join(options.outputDir, "replay.fixture.json");
  const rawCapturePath = path.join(options.outputDir, "raw.capture.jsonl");

  await fs.writeFile(
    fixturePath,
    `${JSON.stringify(options.fixture, null, 2)}\n`,
    "utf8"
  );
  await fs.writeFile(
    rawCapturePath,
    `${options.rawCaptureRecords
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
    "utf8"
  );

  return {
    fixturePath,
    rawCapturePath,
  };
}

export async function exportSessionCapture(
  options: ExportSessionCaptureOptions
): Promise<ExportedSessionCapture> {
  const indexPath = path.join(options.captureRoot, "index.json");
  const index = await readCaptureIndex(indexPath);
  const entry = resolveCaptureIndexEntry(index, indexPath, options);

  try {
    await fs.access(entry.path);
  } catch {
    throw new Error(
      `Recorded capture file is missing: ${entry.path}`
    );
  }

  await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
  await fs.copyFile(entry.path, options.outputPath);

  return {
    captureId: entry.captureId,
    sourcePath: entry.path,
    outputPath: options.outputPath,
  };
}

async function readCaptureIndex(
  indexPath: string
): Promise<Record<string, CaptureIndexEntry>> {
  let contents: string;
  try {
    contents = await fs.readFile(indexPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Capture index not found at ${indexPath}`);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new Error(`Invalid capture index ${indexPath}: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid capture index ${indexPath}: expected object`);
  }

  return parsed as Record<string, CaptureIndexEntry>;
}

function resolveCaptureIndexEntry(
  index: Record<string, CaptureIndexEntry>,
  indexPath: string,
  options: ExportSessionCaptureOptions
): CaptureIndexEntry {
  if (options.captureId?.trim()) {
    const normalizedCaptureId = options.captureId.trim().replace(/\.jsonl$/, "");
    const entry = index[normalizedCaptureId];
    if (!entry) {
      throw new Error(
        `No recorded capture ${normalizedCaptureId} in ${indexPath}`
      );
    }
    return entry;
  }

  const selector = parseSessionSelector(options);
  if (!selector) {
    throw new Error(
      "Expected --capture-id or a backend-qualified --session/--thread selector"
    );
  }

  const matches = Object.values(index)
    .filter(
      (entry) =>
        entry.backend === selector.backend
        && entry.threadIds.includes(selector.threadId)
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);

  if (matches.length === 0) {
    throw new Error(
      `No recorded capture for ${selector.backend}:${selector.threadId} in ${indexPath}`
    );
  }

  return matches[0];
}

function parseSessionSelector(
  options: ExportSessionCaptureOptions
): {
  backend: "codex" | "grok";
  threadId: string;
} | undefined {
  const rawSelector = options.sessionId?.trim() || options.threadId?.trim();
  if (!rawSelector) {
    return undefined;
  }

  if (rawSelector.includes(":")) {
    const [backend, ...threadParts] = rawSelector.split(":");
    const threadId = threadParts.join(":").trim();
    if (
      (backend === "codex" || backend === "grok")
      && threadId
    ) {
      return {
        backend,
        threadId,
      };
    }
  }

  if (!options.backend) {
    throw new Error(
      `Thread selector ${rawSelector} is missing a backend prefix and no --backend was provided`
    );
  }

  return {
    backend: options.backend,
    threadId: rawSelector,
  };
}

function selectCaptureWindow(
  records: CapturedEnvelopeRecord[],
  options: Pick<DeriveReplayFixtureOptions, "startSequence" | "endSequence">
): CapturedEnvelopeRecord[] {
  return records.filter((entry) => {
    if (
      options.startSequence !== undefined
      && entry.record.sequence < options.startSequence
    ) {
      return false;
    }
    if (
      options.endSequence !== undefined
      && entry.record.sequence > options.endSequence
    ) {
      return false;
    }
    return true;
  });
}

function filterCaptureRecordsByThread(
  records: CapturedEnvelopeRecord[],
  threadId?: string
): CapturedEnvelopeRecord[] {
  const normalizedThreadId = threadId?.trim();
  if (!normalizedThreadId) {
    return records;
  }

  return records.filter((entry) => {
    if (entry.record.threadIds.length === 0) {
      return true;
    }

    return entry.record.threadIds.includes(normalizedThreadId);
  });
}

function inferThreadId(records: CapturedEnvelopeRecord[]): string | undefined {
  const threadIds = new Set<string>();
  for (const entry of records) {
    for (const threadId of entry.record.threadIds) {
      threadIds.add(threadId);
    }
  }

  return threadIds.size === 1 ? [...threadIds][0] : undefined;
}

function getStepId(params: {
  sequence: number;
  base: string;
  counts: Map<string, number>;
  labels?: Record<number, string>;
}): string {
  const base = slugStepBase(params.base);
  const nextCount = (params.counts.get(base) ?? 0) + 1;
  params.counts.set(base, nextCount);

  const explicit = params.labels?.[params.sequence];
  if (explicit?.trim()) {
    return explicit.trim();
  }

  return `${base}-${nextCount}`;
}

function slugStepBase(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "step";
}
