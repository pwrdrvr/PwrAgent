import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../desktop-api";
import { useBackendSummaries } from "../useBackendSummaries";

type Owner = "a" | "b";
type Command =
  | { kind: "switch"; owner: Owner }
  | { kind: "suspend"; suspended: boolean }
  | { kind: "gesture" }
  | { kind: "complete"; pick: number; fetchedAt: number }
  | { kind: "fail"; pick: number };

type List = NonNullable<DesktopApi["listBackends"]>;
type Reply = Awaited<ReturnType<List>>;

async function replay(commands: Command[]) {
  let owner: Owner = "a";
  let suspended = false;
  let newest: { owner: Owner; fetchedAt: number; acceptedAt: number } | undefined;
  let visible: { owner: Owner; fetchedAt: number } | undefined;
  let settled = 0;
  const waiting: Array<{
    owner: Owner;
    quota: boolean;
    startedAt: number;
    result: PromiseWithResolvers<Reply>;
  }> = [];
  const targets = {
    a: { scope: "remote", instanceId: "a" },
    b: { scope: "remote", instanceId: "b" },
  } as const;
  const listBackends = vi.fn<List>(async (request) => {
    const target = request?.federationTarget;
    const source = target?.scope === "remote" && target.instanceId === "b" ? "b" : "a";
    const result = Promise.withResolvers<Reply>();
    waiting.push({ owner: source, quota: request?.refreshAntigravityQuota === true, startedAt: settled, result });
    return await result.promise;
  });
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const desktopApi = { listBackends };
  const { result, rerender, unmount } = renderHook(
    (props: { owner: Owner; suspended: boolean }) =>
      useBackendSummaries(desktopApi, { federationTarget: targets[props.owner], suspended: props.suspended }),
    { initialProps: { owner: owner as Owner, suspended } },
  );
  try {
    for (const [step, command] of commands.entries()) {
      const label = `step ${step + 1} (${command.kind}, owner ${owner})`;
      if (command.kind === "switch" || command.kind === "suspend") {
        if (command.kind === "switch") owner = command.owner;
        else suspended = command.suspended;
        rerender({ owner, suspended });
      } else if (command.kind === "gesture") {
        const count = listBackends.mock.calls.length;
        const alreadyWaiting = waiting.some((read) => read.owner === owner && read.quota);
        await act(async () => { result.current.requestAntigravityQuota(); });
        expect(listBackends.mock.calls.length - count, label).toBe(suspended || alreadyWaiting ? 0 : 1);
      } else if (waiting.length) {
        const [read] = waiting.splice(command.pick % waiting.length, 1);
        if (command.kind === "fail") {
          const previousError = result.current.error;
          await act(async () => { read.result.reject(new Error(`Owner request ${step} failed`)); });
          if (read.owner === owner && !suspended) {
            if (newest?.owner === owner && newest.acceptedAt > read.startedAt) {
              expect(result.current.error, label).toBe(previousError);
            } else if (!read.quota || visible?.owner !== owner) visible = undefined;
          }
        } else {
          const { fetchedAt } = command;
          const label = `${read.owner}:${fetchedAt}`;
          await act(async () => {
            read.result.resolve({
              fetchedAt,
              backends: [{
                kind: "acp:antigravity", label, available: true, methods: [], executionModes: [],
                capabilities: {
                  listThreads: true, createThread: true, resumeThread: true, renameThread: true,
                  readThread: true, startTurn: true, interruptTurn: true, steerTurn: false,
                  transcriptPagination: false, toolUse: true, approvalRequests: true, multiDirectoryThreads: true,
                },
              }],
            });
          });
          if (read.owner === owner && !suspended && (newest?.owner !== owner || fetchedAt >= newest.fetchedAt)) {
            newest = { owner, fetchedAt, acceptedAt: ++settled };
            visible = newest;
          }
        }
      }
      const shown = result.current.backends[0]?.label;
      if (visible?.owner === owner) expect(shown, label).toBe(`${owner}:${visible.fetchedAt}`);
      else expect(shown, label).toBeUndefined();
    }
  } finally {
    unmount();
    focus.mockRestore();
    visibility.mockRestore();
  }
}

describe("Antigravity owner quota sequences", () => {
  it("keeps an in-flight owner request through a round trip to another owner", async () => {
    await replay([
      { kind: "gesture" }, { kind: "switch", owner: "b" }, { kind: "gesture" },
      { kind: "switch", owner: "a" }, { kind: "gesture" },
    ]);
  });

  it("shows no quota for the new owner before its first response", async () => {
    await replay([{ kind: "complete", pick: 0, fetchedAt: 1 }, { kind: "switch", owner: "b" }]);
  });

  it("keeps a completed quota snapshot when an older request fails", async () => {
    await replay([{ kind: "gesture" }, { kind: "complete", pick: 1, fetchedAt: 2 }, { kind: "fail", pick: 0 }]);
  });

  it("matches the current owner's latest settled response during interleaved gestures", async () => {
    const command: fc.Arbitrary<Command> = fc.oneof(
      fc.record({ kind: fc.constant("switch"), owner: fc.constantFrom("a", "b") }),
      fc.record({ kind: fc.constant("suspend"), suspended: fc.boolean() }),
      fc.constant({ kind: "gesture" }),
      fc.record({ kind: fc.constant("complete"), pick: fc.nat(12), fetchedAt: fc.nat(20) }),
      fc.record({ kind: fc.constant("fail"), pick: fc.nat(12) }),
    );
    await fc.assert(fc.asyncProperty(fc.array(command, { minLength: 7, maxLength: 24, size: "max" }), replay), {
      numRuns: 5,
    });
  });
});
