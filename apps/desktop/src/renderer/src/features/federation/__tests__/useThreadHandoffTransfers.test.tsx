import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HandoffInstanceThreadResult, ThreadHandoffProgress } from "@pwragent/shared";
import { useThreadHandoffTransfer, type ThreadHandoffStore } from "../thread-handoff-store";
import { useThreadHandoffTransfers } from "../useThreadHandoffTransfers";

afterEach(() => {
  cleanup();
});

function fakeApi() {
  let emit: ((progress: ThreadHandoffProgress) => void) | undefined;
  let finish: ((result: HandoffInstanceThreadResult) => void) | undefined;
  return {
    api: {
      handoffThreadToInstance: async () => await new Promise<HandoffInstanceThreadResult>((resolve) => {
        finish = resolve;
      }),
      onThreadHandoffProgress: (callback: (progress: ThreadHandoffProgress) => void) => {
        emit = callback;
        return () => {
          emit = undefined;
        };
      },
    },
    emit: (progress: ThreadHandoffProgress) => emit?.(progress),
    finish: (result: HandoffInstanceThreadResult) => finish?.(result),
  };
}

describe("useThreadHandoffTransfers", () => {
  it("re-renders the window on an outcome, and only the live view on each byte report", async () => {
    const { api, emit, finish } = fakeApi();
    const renders = { host: 0, live: 0 };
    let hook: ReturnType<typeof useThreadHandoffTransfers> | undefined;

    function Live(props: { store: ThreadHandoffStore; handoffId: string | undefined }) {
      renders.live += 1;
      const transfer = useThreadHandoffTransfer(props.store, props.handoffId);
      return <span data-testid="bytes">{transfer?.bytesCommitted ?? 0}</span>;
    }
    function Host() {
      renders.host += 1;
      hook = useThreadHandoffTransfers(api);
      return <Live store={hook.store} handoffId={Object.keys(hook.transfers)[0]} />;
    }

    const view = render(<Host />);
    let started: Promise<unknown> | undefined;
    act(() => {
      started = hook!.start({
        sourceThreadId: "thread-1",
        threadKey: "codex:thread-1",
        title: "Release v0.17",
        targetLabel: "studio-mac",
        choice: { targetInstanceId: "pwr_studio", operation: "copy" },
      });
    });
    const handoffId = Object.keys(hook!.transfers)[0]!;
    const hostBefore = renders.host;
    const liveBefore = renders.live;

    act(() => {
      for (let sent = 1; sent <= 50; sent += 1) {
        emit({
          handoffId,
          sourceThreadId: "thread-1",
          phase: "send",
          bytesCommitted: sent * 1024,
          bytesTotal: 50 * 1024,
          link: "connected",
          cancelable: true,
          transport: "resumable",
        });
      }
    });
    expect(view.getByTestId("bytes")).toHaveTextContent(String(50 * 1024));
    // Byte reports change nothing the window places or shows as an outcome.
    expect(renders.host).toBe(hostBefore);
    expect(renders.live).toBeGreaterThan(liveBefore);

    await act(async () => {
      finish({
        handoffId,
        sourceThreadId: "thread-1",
        instanceId: "pwr_studio",
        backend: "codex",
        threadId: "thread-9",
        directoryPath: "/w",
        sourceArchived: false,
        warnings: [],
      });
      await started;
    });
    // The outcome is what the window acts on.
    expect(renders.host).toBeGreaterThan(hostBefore);
    expect(hook!.transfers[handoffId]?.status).toBe("succeeded");
  });
});
