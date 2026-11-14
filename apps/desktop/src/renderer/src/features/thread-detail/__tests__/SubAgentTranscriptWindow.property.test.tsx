import { act, render } from "@testing-library/react";
import type { AppServerBackendKind } from "@pwragent/shared";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THREAD_HISTORY_PAGE_LIMIT } from "../../../lib/thread-history-limits";
import { SubAgentTranscriptWindow } from "../SubAgentTranscriptWindow";

vi.mock("../TranscriptList", () => ({ TranscriptList: () => null }));

describe("sub-agent transcript address routing", () => {
  const originalHash = window.location.hash;

  afterEach(() => {
    delete (window as Window & { pwragent?: unknown }).pwragent;
    window.location.hash = originalHash;
  });

  // Every supported provider must reach readThread with the identity and
  // owner encoded by the window opener, regardless of the display title.
  it.each<AppServerBackendKind>(["codex", "claude", "acp:fixture"])(
    "preserves %s child identities and owners through the window address",
    async (backend) => {
      await fc.assert(fc.asyncProperty(
        fc.uuid(),
        fc.string({ maxLength: 40 }),
        fc.option(fc.uuid(), { nil: undefined }),
        async (threadId, suffix, instanceId) => {
          const title = `Child / # % 🧭 ${suffix}`.trim();
          const readThread = vi.fn(async () => ({
            backend,
            threadId,
            fetchedAt: 123,
            replay: {
              entries: [],
              messages: [],
              pagination: { supportsPagination: false, hasPreviousPage: false },
            },
          }));
          (window as Window & { pwragent?: unknown }).pwragent = { readThread };
          window.location.hash = [
            "#sub-agent",
            encodeURIComponent(backend),
            encodeURIComponent(threadId),
            encodeURIComponent(title),
            ...(instanceId ? [encodeURIComponent(instanceId)] : []),
          ].join("/");

          let view: ReturnType<typeof render> | undefined;
          try {
            await act(async () => { view = render(<SubAgentTranscriptWindow />); });
            expect(readThread).toHaveBeenCalledExactlyOnceWith({
              backend,
              threadId,
              limit: THREAD_HISTORY_PAGE_LIMIT,
              viewOnly: true,
              ...(instanceId ? { federationTarget: { scope: "remote", instanceId } } : {}),
            });
          } finally {
            view?.unmount();
          }
        },
      ), { numRuns: 25 });
    },
  );
});
