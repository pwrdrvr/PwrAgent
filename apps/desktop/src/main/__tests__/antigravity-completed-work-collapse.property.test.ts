import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  AcpSessionReplayNormalizer,
  acpSessionReplayNormalizerOptions,
} from "../acp/acp-session-normalizer";
import { shapeReadThreadFileDiffsForRenderer } from "../app-server/thread-file-diff-cache";
import {
  buildTranscriptRenderItems,
  type TranscriptRenderItem,
} from "../../renderer/src/features/thread-detail/transcript-render-items";

// Model-based property test for fake Antigravity ACP turns through the full
// replay -> diff-cache shaping (local & Federation) -> transcript render items
// pipeline.
//
// Invariant:
//   After a completed Antigravity turn finishes, every intermediate step
//   between the user prompt (or steer) and the final answer — thoughts, reads,
//   commands, file edits (inline or diffRef-cached), failed tools, and
//   mid-turn progress messages — collapses into one work group. Inside that
//   work group, consecutive edits stay grouped and every edit patch is
//   preserved in exact chronological order.

type FakeStep =
  | { kind: "thought"; text: string }
  | { kind: "read"; file: string }
  | { kind: "command"; label: string }
  | { kind: "edit"; file: string; create: boolean }
  | { kind: "failedTool"; label: string }
  | { kind: "progressMessage"; chunks: string[] };

type FakeTurnScenario = {
  steps: FakeStep[];
  finalAnswerChunks: string[];
  durationMs: number;
};

type FakeSteeredScenario = {
  beforeSteer: FakeStep[];
  replyBeforeSteer: boolean;
  afterSteer: FakeStep[];
  finalAnswerChunks: string[];
  durationMs: number;
};

const FILE_PATHS = [
  "/work/src/alpha.ts",
  "/work/src/beta.ts",
  "/work/src/gamma.ts",
  "/work/src/delta.ts",
];

const fakeStepArb: fc.Arbitrary<FakeStep> = fc.oneof(
  {
    weight: 3,
    arbitrary: fc.integer({ min: 1, max: 999 }).map((n) => ({
      kind: "thought" as const,
      text: `Reasoning step ${n} about the next action.`,
    })),
  },
  {
    weight: 3,
    arbitrary: fc.constantFrom(...FILE_PATHS).map((file) => ({
      kind: "read" as const,
      file,
    })),
  },
  {
    weight: 3,
    arbitrary: fc.integer({ min: 1, max: 999 }).map((n) => ({
      kind: "command" as const,
      label: `Run check ${n}`,
    })),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("edit" as const),
      file: fc.constantFrom(...FILE_PATHS),
      create: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.integer({ min: 1, max: 999 }).map((n) => ({
      kind: "failedTool" as const,
      label: `Failed check ${n}`,
    })),
  },
  {
    weight: 3,
    arbitrary: fc.array(
      fc.integer({ min: 1, max: 999 }).map((n) => `Progress update chunk ${n}. `),
      { minLength: 1, maxLength: 2 },
    ).map((chunks) => ({
      kind: "progressMessage" as const,
      chunks,
    })),
  },
);

const fakeTurnScenarioArb: fc.Arbitrary<FakeTurnScenario> = fc.record({
  steps: fc.array(fakeStepArb, { minLength: 1, maxLength: 18 }),
  finalAnswerChunks: fc.array(
    fc.integer({ min: 1, max: 999 }).map((n) => `Final summary part ${n}. `),
    { minLength: 1, maxLength: 3 },
  ),
  durationMs: fc.integer({ min: 70_000, max: 3_600_000 }),
});

const fakeSteeredScenarioArb: fc.Arbitrary<FakeSteeredScenario> = fc.record({
  beforeSteer: fc.array(fakeStepArb, { minLength: 1, maxLength: 8 }),
  replyBeforeSteer: fc.boolean(),
  afterSteer: fc.array(fakeStepArb, { minLength: 1, maxLength: 8 }),
  finalAnswerChunks: fc.array(
    fc.integer({ min: 1, max: 999 }).map((n) => `Final summary part ${n}. `),
    { minLength: 1, maxLength: 2 },
  ),
  durationMs: fc.integer({ min: 70_000, max: 3_600_000 }),
});

function replayFakeAcpTurn(params: {
  backend?: AppServerBackendKind;
  segments: Array<{
    prompt?: string;
    steps: FakeStep[];
    closingChunks?: string[];
  }>;
  durationMs: number;
  terminalStatus?: "completed" | "cancelled" | "interrupted";
}): {
  inlineEntries: AppServerThreadEntry[];
  cachedEntries: AppServerThreadEntry[];
  expectedEditCallIds: string[];
} {
  const backend = params.backend ?? "acp:antigravity";
  const sessionId = "fake-agy-session";
  const normalizer = new AcpSessionReplayNormalizer(
    acpSessionReplayNormalizerOptions(backend, "/work"),
  );
  const startedAt = 1_795_710_000_000;
  let timestamp = startedAt;
  let callIndex = 0;
  const fileContents = new Map<string, string>();
  const expectedEditCallIds: string[] = [];

  const apply = (update: Record<string, unknown>) => {
    timestamp += 100;
    normalizer.apply({ sessionId, receivedAt: timestamp, update });
  };

  normalizer.apply({
    sessionId,
    receivedAt: startedAt,
    update: {
      sessionUpdate: "pwragent_user_prompt",
      turnId: "turn-1",
      content: { type: "text", text: "Implement and verify the feature." },
    },
  });

  for (const [segmentIndex, segment] of params.segments.entries()) {
    if (segmentIndex > 0 && segment.prompt) {
      apply({
        sessionUpdate: "pwragent_steered_user_prompt",
        turnId: "turn-1",
        steerMessageId: `steer-${segmentIndex}`,
        content: { type: "text", text: segment.prompt },
      });
    }
    for (const step of segment.steps) {
      if (step.kind === "thought") {
        apply({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: step.text },
        });
        continue;
      }
      if (step.kind === "progressMessage") {
        for (const chunk of step.chunks) {
          apply({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: chunk },
          });
        }
        continue;
      }
      callIndex += 1;
      const toolCallId = `call_${callIndex}`;
      if (step.kind === "read") {
        apply({
          sessionUpdate: "tool_call",
          toolCallId,
          name: "read_file",
          title: `Read ${step.file}`,
          kind: "read",
          status: "in_progress",
          rawInput: { Path: step.file },
          locations: [{ path: step.file }],
        });
        apply({
          sessionUpdate: "tool_call_update",
          toolCallId,
          name: "read_file",
          title: `Read ${step.file}`,
          kind: "read",
          status: "completed",
          rawOutput: { content: "ok" },
        });
        continue;
      }
      if (step.kind === "command") {
        apply({
          sessionUpdate: "tool_call",
          toolCallId,
          name: "run_command",
          title: step.label,
          kind: "execute",
          status: "in_progress",
          rawInput: { CommandLine: `echo "${step.label}"` },
        });
        apply({
          sessionUpdate: "tool_call_update",
          toolCallId,
          name: "run_command",
          title: step.label,
          kind: "execute",
          status: "completed",
          rawOutput: { output: "ok" },
        });
        continue;
      }
      if (step.kind === "failedTool") {
        apply({
          sessionUpdate: "tool_call",
          toolCallId,
          name: "run_command",
          title: step.label,
          kind: "execute",
          status: "in_progress",
          rawInput: { CommandLine: `false # ${step.label}` },
        });
        apply({
          sessionUpdate: "tool_call_update",
          toolCallId,
          name: "run_command",
          title: step.label,
          kind: "execute",
          status: "failed",
          rawOutput: { error: "command failed" },
        });
        continue;
      }
      expectedEditCallIds.push(toolCallId);
      const previous = fileContents.get(step.file);
      const isCreate = step.create && previous === undefined;
      const oldText = isCreate ? undefined : (previous ?? `export const v = 0;\n`);
      const newText = `export const v = ${callIndex};\n`;
      fileContents.set(step.file, newText);
      const rawInput = isCreate
        ? { Path: step.file, Content: newText, Overwrite: true }
        : { Path: step.file, Target: oldText, Replacement: newText };
      const call = {
        toolCallId,
        name: isCreate ? "write_file" : "edit_file",
        title: `Editing ${step.file}`,
        kind: "edit",
        rawInput,
        args: rawInput,
        locations: [{ path: step.file }],
      };
      apply({ ...call, sessionUpdate: "tool_call", status: "in_progress" });
      apply({
        ...call,
        sessionUpdate: "tool_call_update",
        status: "completed",
        rawOutput: {},
        content: [{
          type: "diff",
          path: step.file,
          newText,
          ...(oldText === undefined ? {} : { oldText }),
        }],
      });
    }
    for (const chunk of segment.closingChunks ?? []) {
      apply({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: chunk },
      });
    }
  }

  const completedAt = startedAt + params.durationMs;
  normalizer.apply({
    sessionId,
    receivedAt: completedAt,
    update: {
      sessionUpdate: "turn_finished",
      ...(params.terminalStatus === "cancelled" || params.terminalStatus === "interrupted"
        ? { stopReason: "cancelled" }
        : { stopReason: "end_turn" }),
    },
  });

  const replay = normalizer.replay();
  const response: AppServerReadThreadResponse = {
    backend,
    threadId: sessionId,
    fetchedAt: completedAt,
    replay,
  };
  const shaped = shapeReadThreadFileDiffsForRenderer(response);
  return {
    inlineEntries: replay.entries,
    cachedEntries: shaped.replay.entries,
    expectedEditCallIds,
  };
}

function renderSignature(items: TranscriptRenderItem[]): string[] {
  return items.map((item) => {
    if (item.type === "workPhaseGroup") {
      return `group:${item.label}:${item.entries.length}:${item.defaultExpanded ? "open" : "closed"}`;
    }
    if (item.entry.type === "message") {
      return `msg:${item.entry.role}:${item.entry.phase ?? "none"}:${item.entry.id}`;
    }
    return `${item.entry.type}:${item.entry.id}`;
  });
}

function collectEditDetailIds(items: TranscriptRenderItem[]): string[] {
  const result: string[] = [];
  const visit = (entry: AppServerThreadEntry) => {
    if (entry.type !== "activity") return;
    for (const detail of entry.details) {
      if (detail.kind === "write" && detail.fileDiff) {
        result.push(detail.id);
      }
    }
  };
  for (const item of items) {
    if (item.type === "entry") {
      visit(item.entry);
    } else {
      for (const entry of item.entries) {
        visit(entry);
      }
    }
  }
  return result;
}

function hasAnyConcreteStep(steps: FakeStep[]): boolean {
  return steps.some(
    (step) =>
      step.kind === "read"
      || step.kind === "command"
      || step.kind === "edit"
      || step.kind === "failedTool",
  );
}

describe("Antigravity completed work collapse (fake ACP MBT)", () => {
  it("collapses every intermediate thought, tool, edit, failed tool, and progress reply into one work group before the final answer", () => {
    fc.assert(
      fc.property(fakeTurnScenarioArb, (scenario) => {
        const { inlineEntries, cachedEntries, expectedEditCallIds } = replayFakeAcpTurn({
          segments: [{ steps: scenario.steps, closingChunks: scenario.finalAnswerChunks }],
          durationMs: scenario.durationMs,
        });
        const inlineItems = buildTranscriptRenderItems({
          entries: inlineEntries,
          backend: "acp:antigravity",
        });
        const cachedItems = buildTranscriptRenderItems({
          entries: cachedEntries,
          backend: "acp:antigravity",
        });

        // Inline (local live) and cached/diffRef (replay & Federation) must
        // render the exact same collapsed shape.
        expect(renderSignature(cachedItems)).toEqual(renderSignature(inlineItems));

        // Every edit patch stays preserved in chronological order inside the
        // rendered structure.
        expect(collectEditDetailIds(inlineItems)).toEqual(expectedEditCallIds);
        expect(collectEditDetailIds(cachedItems)).toEqual(expectedEditCallIds);

        const hasVisibleFinal = inlineEntries.some(
          (entry): entry is AppServerThreadMessageEntry =>
            entry.type === "message" && entry.role === "assistant",
        );
        expect(hasVisibleFinal).toBe(true);

        const nonUserItems = inlineItems.slice(1);
        expect(inlineItems[0]).toMatchObject({
          type: "entry",
          entry: { type: "message", role: "user" },
        });

        const lastItem = nonUserItems.at(-1);
        expect(lastItem).toMatchObject({
          type: "entry",
          entry: { type: "message", role: "assistant" },
        });

        const workGroups = nonUserItems.filter((item) => item.type === "workPhaseGroup");
        const topLevelAssistantMessages = nonUserItems.filter(
          (item) =>
            item.type === "entry"
            && item.entry.type === "message"
            && item.entry.role === "assistant",
        );
        const topLevelActivities = nonUserItems.filter(
          (item) => item.type === "entry" && item.entry.type === "activity",
        );

        expect(topLevelActivities).toEqual([]);
        expect(topLevelAssistantMessages).toHaveLength(1);

        if (hasAnyConcreteStep(scenario.steps)) {
          expect(workGroups).toHaveLength(1);
          expect(workGroups[0]?.label).toMatch(/^Worked for /);
          expect(nonUserItems).toHaveLength(2);
        } else {
          expect(workGroups.length).toBeLessThanOrEqual(1);
          expect(nonUserItems.length).toBeLessThanOrEqual(2);
        }
      }),
    );
  });

  it("preserves mid-turn steers and collapses each segment without leaking edits or progress replies", () => {
    fc.assert(
      fc.property(fakeSteeredScenarioArb, (scenario) => {
        const { inlineEntries, cachedEntries, expectedEditCallIds } = replayFakeAcpTurn({
          segments: [
            {
              steps: scenario.beforeSteer,
              ...(scenario.replyBeforeSteer
                ? { closingChunks: ["Should I continue with the second half?"] }
                : {}),
            },
            {
              prompt: "Yes, please finish the second half.",
              steps: scenario.afterSteer,
              closingChunks: scenario.finalAnswerChunks,
            },
          ],
          durationMs: scenario.durationMs,
        });

        const inlineItems = buildTranscriptRenderItems({
          entries: inlineEntries,
          backend: "acp:antigravity",
        });
        const cachedItems = buildTranscriptRenderItems({
          entries: cachedEntries,
          backend: "acp:antigravity",
        });

        expect(renderSignature(cachedItems)).toEqual(renderSignature(inlineItems));
        expect(collectEditDetailIds(cachedItems)).toEqual(expectedEditCallIds);

        // Both the opening prompt and the steer stay visible outside work groups.
        const userIndices = inlineItems
          .map((item, index) =>
            item.type === "entry" && item.entry.type === "message" && item.entry.role === "user"
              ? index
              : -1,
          )
          .filter((index) => index >= 0);
        expect(userIndices).toHaveLength(2);

        const beforeSteerItems = inlineItems.slice(userIndices[0]! + 1, userIndices[1]!);
        const afterSteerItems = inlineItems.slice(userIndices[1]! + 1);

        // Neither segment may leak mid-turn edits or split work into multiple
        // groups around interim replies. Before a steer, a final reply the
        // operator answered can stay in view with at most one group before it
        // and one trailing thought/failed-call group right before the steer.
        for (const [segmentIndex, segmentItems] of [beforeSteerItems, afterSteerItems].entries()) {
          const groups = segmentItems.filter((item) => item.type === "workPhaseGroup");
          const topLevelActivities = segmentItems.filter(
            (item) => item.type === "entry" && item.entry.type === "activity",
          );
          const topLevelAssistant = segmentItems.filter(
            (item) =>
              item.type === "entry"
              && item.entry.type === "message"
              && item.entry.role === "assistant",
          );
          expect(topLevelActivities).toEqual([]);
          expect(topLevelAssistant.length).toBeLessThanOrEqual(1);
          if (segmentIndex === 1) {
            expect(groups.length).toBeLessThanOrEqual(1);
          } else {
            expect(groups.length).toBeLessThanOrEqual(topLevelAssistant.length + 1);
          }
        }

        // The second segment ends with the single final answer.
        expect(afterSteerItems.at(-1)).toMatchObject({
          type: "entry",
          entry: { type: "message", role: "assistant" },
        });
        // If the agent replied directly before the steer, that reply stays visible above the steer.
        if (scenario.replyBeforeSteer) {
          expect(beforeSteerItems.at(-1)).toMatchObject({
            type: "entry",
            entry: { type: "message", role: "assistant" },
          });
        }
      }),
    );
  });

  it("keeps a stopped Antigravity turn's edits and tools together in one open work group", () => {
    fc.assert(
      fc.property(
        fc.array(fakeStepArb, { minLength: 1, maxLength: 12 }).filter(hasAnyConcreteStep),
        fc.constantFrom("cancelled" as const, "interrupted" as const),
        (steps, terminalStatus) => {
          // Ensure the stopped turn ended during concrete work (no final answer after).
          const workSteps: FakeStep[] = [
            ...steps,
            { kind: "edit", file: "/work/src/alpha.ts", create: false },
          ];
          const { inlineEntries, cachedEntries, expectedEditCallIds } = replayFakeAcpTurn({
            segments: [{ steps: workSteps }],
            durationMs: 120_000,
            terminalStatus,
          });
          const inlineItems = buildTranscriptRenderItems({
            entries: inlineEntries,
            backend: "acp:antigravity",
          });
          const cachedItems = buildTranscriptRenderItems({
            entries: cachedEntries,
            backend: "acp:antigravity",
          });

          expect(renderSignature(cachedItems)).toEqual(renderSignature(inlineItems));
          expect(collectEditDetailIds(cachedItems)).toEqual(expectedEditCallIds);
          expect(inlineItems).toHaveLength(2);
          expect(inlineItems[1]).toMatchObject({
            type: "workPhaseGroup",
            collapsible: true,
            defaultExpanded: true,
          });
        },
      ),
    );
  });

  it("keeps edits grouped inside the collapsed work group with patches intact when expanded", () => {
    const { cachedEntries } = replayFakeAcpTurn({
      segments: [{
        steps: [
          { kind: "thought", text: "Planning the change." },
          { kind: "read", file: "/work/src/alpha.ts" },
          { kind: "edit", file: "/work/src/alpha.ts", create: false },
          { kind: "edit", file: "/work/src/alpha.ts", create: false },
          { kind: "command", label: "Run tests" },
          { kind: "progressMessage", chunks: ["Tests passed; opening PR now."] },
          { kind: "edit", file: "/work/src/beta.ts", create: true },
          { kind: "command", label: "Create PR" },
        ],
        closingChunks: ["Opened PR #99."],
      }],
      durationMs: 2_312_651,
    });

    const items = buildTranscriptRenderItems({
      entries: cachedEntries,
      backend: "acp:antigravity",
    });

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ type: "entry", entry: { type: "message", role: "user" } });
    expect(items[1]).toMatchObject({
      type: "workPhaseGroup",
      collapsible: true,
      label: expect.stringMatching(/^Worked for 38m 32s/),
    });
    expect(items[2]).toMatchObject({
      type: "entry",
      entry: { type: "message", role: "assistant", text: "Opened PR #99." },
    });

    const group = items[1];
    expect(group?.type).toBe("workPhaseGroup");
    if (group?.type === "workPhaseGroup") {
      const groupedEdit = group.entries.find(
        (entry): entry is AppServerThreadActivityEntry =>
          entry.type === "activity" && entry.summary === "Edited 1 file · 2 edits",
      );
      expect(groupedEdit?.details).toHaveLength(2);
      expect(groupedEdit?.details.every((detail) => Boolean(detail.fileDiff?.diffRef))).toBe(true);
    }
  });
});
