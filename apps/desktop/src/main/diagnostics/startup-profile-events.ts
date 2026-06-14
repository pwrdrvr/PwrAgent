import { performance } from "node:perf_hooks";
import type {
  StartupCpuProfileSession,
  StartupCpuProfileSessionEvent,
} from "./startup-cpu-profile-session";

export type StartupProfileEventSource = StartupCpuProfileSessionEvent["source"];

type StartupProfileEventRecorder = {
  dispose: () => void;
  flush: () => Promise<void>;
  record: (
    source: StartupProfileEventSource,
    type: string,
    detail?: Record<string, unknown>,
  ) => void;
};

let activeRecorder: StartupProfileEventRecorder | undefined;

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }

  return {
    message: String(error),
  };
}

export function installStartupProfileEventRecorder(options: {
  now?: () => Date;
  session: StartupCpuProfileSession;
  startTimeMs?: number;
}): () => void {
  const now = options.now ?? (() => new Date());
  const startTimeMs = options.startTimeMs ?? performance.now();
  let appendQueue = Promise.resolve();
  let disposed = false;

  const recorder: StartupProfileEventRecorder = {
    dispose: () => {
      disposed = true;
      if (activeRecorder === recorder) {
        activeRecorder = undefined;
      }
    },
    flush: async () => {
      await appendQueue;
    },
    record: (source, type, detail) => {
      if (disposed) {
        return;
      }

      const elapsedMs = Math.max(0, performance.now() - startTimeMs);
      appendQueue = appendQueue.then(
        () =>
          options.session.appendEvent({
            source,
            capturedAt: now().toISOString(),
            type,
            detail: {
              elapsedMs: Number(elapsedMs.toFixed(3)),
              ...(detail ?? {}),
            },
          }),
        () =>
          options.session.appendEvent({
            source,
            capturedAt: now().toISOString(),
            type,
            detail: {
              elapsedMs: Number(elapsedMs.toFixed(3)),
              ...(detail ?? {}),
            },
          }),
      );
      void appendQueue;
    },
  };
  activeRecorder = recorder;

  return () => {
    recorder.dispose();
  };
}

export function isStartupProfileRecordingActive(): boolean {
  return activeRecorder !== undefined;
}

export async function flushStartupProfileEvents(): Promise<void> {
  await activeRecorder?.flush();
}

export function recordStartupProfileEvent(params: {
  detail?: Record<string, unknown>;
  source?: StartupProfileEventSource;
  type: string;
}): void {
  activeRecorder?.record(params.source ?? "main", params.type, params.detail);
}

export async function timeStartupProfileOperation<T>(params: {
  detail?: Record<string, unknown>;
  operation: () => Promise<T>;
  source?: StartupProfileEventSource;
  type: string;
}): Promise<T> {
  if (!activeRecorder) {
    return await params.operation();
  }

  const source = params.source ?? "main";
  const startedAt = performance.now();
  activeRecorder.record(source, `${params.type}:start`, params.detail);

  try {
    const result = await params.operation();
    activeRecorder.record(source, `${params.type}:end`, {
      ...(params.detail ?? {}),
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
      ok: true,
    });
    return result;
  } catch (error) {
    activeRecorder.record(source, `${params.type}:end`, {
      ...(params.detail ?? {}),
      durationMs: Number((performance.now() - startedAt).toFixed(3)),
      error: serializeError(error),
      ok: false,
    });
    throw error;
  }
}
