import { act, type RenderResult } from "@testing-library/react";
import { onTestFinished } from "vitest";
import type { DesktopApi } from "../lib/desktop-api";

export async function renderThreadApp(
  api: DesktopApi,
  renderApp: () => Promise<RenderResult>,
  signal?: AbortSignal,
): Promise<void> {
  const record = api.recordStartupProfileEvent;
  let ready!: () => void;
  let failed!: (error: Error) => void;
  let completed!: () => void;
  const imported = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
  const completion = new Promise<void>((resolve) => { completed = resolve; });
  void imported.catch(() => undefined);
  let importStarted = false;
  let cancelled = false;
  let finished = false;
  let cancelPhase: (() => void) | undefined;
  let view: RenderResult | undefined;
  const cancelledError = new Error("Renderer startup was cancelled.");
  const cancel = () => {
    cancelled = true;
    cancelPhase?.();
    failed(cancelledError);
  };
  api.recordStartupProfileEvent = (type, detail) => {
    if (type === "thread-view-import:start") importStarted = true;
    if (type === "thread-view-import:end") ready();
    if (type === "thread-view-import:error") failed(new Error(String(detail?.error)));
    record?.(type, detail);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  onTestFinished(async () => {
    if (!finished) cancel();
    await completion;
    api.recordStartupProfileEvent = record;
  });
  try {
    if (cancelled) throw cancelledError;
    view = await renderApp();
    // Commit each deferred paint/task separately. Wait for the import's
    // admission event before awaiting its completion inside act.
    while (!importStarted && !cancelled) {
      await act(async () => {
        await new Promise<void>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const done = () => { cancelPhase = undefined; resolve(); };
          const frame = requestAnimationFrame(() => { timer = setTimeout(done, 0); });
          cancelPhase = () => {
            cancelAnimationFrame(frame);
            if (timer !== undefined) clearTimeout(timer);
            done();
          };
        });
      });
    }
    if (cancelled) throw cancelledError;
    await act(async () => { await imported; });
  } finally {
    cancelPhase?.();
    signal?.removeEventListener("abort", cancel);
    if (cancelled) view?.unmount();
    finished = true;
    completed();
  }
}

