import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { AppServerThreadActivityDetail, NavigationThreadSummary } from "@pwragent/shared";
import { afterEach, expect, it } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

afterEach(cleanup);

it.each([
  { calls: 128, grouped: true },
  { calls: 256, grouped: true },
  { calls: 128, grouped: false },
  { calls: 256, grouped: false },
])("bounds replay matching with $calls calls (grouped: $grouped)", async ({ calls, grouped }) => {
  let emit!: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0];
  let replayIdReads = 0;
  let replayEntryReads = 0;
  const details: AppServerThreadActivityDetail[] = Array.from({ length: calls - 1 }, (_, index) => ({
    get id() { replayIdReads += 1; return `call-${index}`; },
    kind: "command",
    label: `fixture ${index}`,
    status: "completed",
    command: { displayCommand: `fixture ${index}` },
  }));
  let replayDetails = details;
  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => { emit = listener; return () => undefined; },
    readThread: async ({ backend, threadId }) => ({
      backend: backend ?? "codex", threadId, fetchedAt: 1000,
      replay: {
        entries: grouped
          ? [{ type: "activity", id: "hydrated", summary: "Tools", details: replayDetails }]
          : replayDetails.map((detail, index) => ({
              type: "activity" as const,
              get id() { replayEntryReads += 1; return `hydrated-${index}`; },
              summary: "Tool", details: [detail],
            })),
        messages: [],
        pagination: { supportsPagination: false, hasPreviousPage: false },
      },
    }),
  };
  const thread: NavigationThreadSummary = {
    id: "thread", title: "Synthetic", titleSource: "explicit", source: "codex",
    linkedDirectories: [], inbox: { inInbox: false }, updatedAt: 1000,
  };
  const { result } = renderHook(() => useThreadSessionState({ desktopApi, thread }));
  await waitFor(() => expect(result.current.response).toBeDefined());
  act(() => {
    for (let index = 0; index < calls; index += 1) {
      emit({ backend: "codex", notification: {
        method: "item/started",
        params: {
          threadId: "thread", turnId: "turn",
          item: { id: `call-${index}`, type: "commandExecution", command: `fixture ${index}`, status: "in_progress" },
        },
      } });
      if (!grouped) {
        emit({ backend: "codex", notification: {
          method: "item/agentMessage/delta",
          params: { threadId: "thread", turnId: "turn", itemId: `message-${index}`, delta: `Separator ${index}` },
        } });
      }
    }
  });
  replayIdReads = 0;
  replayEntryReads = 0;
  for (let index = 0; index < 4; index += 1) {
    act(() => emit({ backend: "codex", notification: {
      method: "item/commandExecution/outputDelta",
      params: { threadId: "thread", turnId: "turn", itemId: `call-${calls - 1}`, delta: "x" },
    } }));
  }
  const reads = replayIdReads;
  const entryReads = replayEntryReads;
  if (process.env.TOOL_OUTPUT_BENCHMARK === "1") {
    process.stdout.write(`${JSON.stringify({ calls, grouped, chunks: 4, replayIdReads: reads, replayEntryReads: entryReads })}\n`);
  }
  const live = result.current.entries.find((entry) => entry.type === "activity" && !entry.id.startsWith("hydrated"));
  expect(live?.type === "activity" && live.details.at(-1)?.command?.output).toBe("xxxx");
  expect(reads).toBeLessThanOrEqual(calls * 4);
  expect(entryReads).toBeLessThanOrEqual(calls * 4 * 40);

  // A fresh authoritative snapshot must invalidate cached
  // matches. The previously missing live call is now present in replay.
  replayDetails = [...details, {
    id: `call-${calls - 1}`, kind: "command", label: `fixture ${calls - 1}`,
    status: "completed", command: { displayCommand: `fixture ${calls - 1}`, output: "xxxx" },
  }];
  await act(async () => { await result.current.reload(); });
  expect(result.current.entries.some((entry) =>
    entry.type === "activity" && !entry.id.startsWith("hydrated"),
  )).toBe(false);
});
