import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  AppServerThreadEntry,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

afterEach(() => {
  cleanup();
});

const BASE_NOW = 1_750_000_000_000;

type DeferredRead = {
  response: AppServerReadThreadResponse;
  resolve: (value: AppServerReadThreadResponse) => void;
};

async function mountSession(params: {
  backend: AppServerBackendKind;
  supportsPagination: boolean;
  snapshot: () => AppServerThreadEntry[];
  isActive?: () => boolean;
}) {
  let now = BASE_NOW;
  const clockSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  let emitListener: (event: AgentEvent) => void = () => {};
  const reads: DeferredRead[] = [];
  let firstRead = true;

  const makeResponse = (): AppServerReadThreadResponse => {
    const entries = params.snapshot();
    return {
      backend: params.backend,
      threadId: "order-thread",
      fetchedAt: now,
      threadStatus: params.isActive?.() ? "active" : "idle",
      replay: {
        entries,
        messages: entries.flatMap((entry) => (entry.type === "message" ? [entry] : [])),
        pagination: params.supportsPagination
          ? { supportsPagination: true, hasPreviousPage: false }
          : { supportsPagination: false, hasPreviousPage: false },
      },
    };
  };

  const desktopApi: DesktopApi = {
    onAgentEvent: (listener) => {
      emitListener = listener;
      return () => undefined;
    },
    readThread: vi.fn(() => {
      const response = makeResponse();
      if (firstRead) {
        firstRead = false;
        return Promise.resolve(response);
      }
      return new Promise<AppServerReadThreadResponse>((resolve) => {
        reads.push({ response, resolve });
      });
    }),
  };

  const thread: NavigationThreadSummary = {
    id: "order-thread",
    title: "Order regression fixture",
    titleSource: "explicit",
    summary: "",
    source: params.backend,
    linkedDirectories: [],
    inbox: { inInbox: false },
    updatedAt: 1,
  };

  const hook = renderHook(() =>
    useThreadSessionState({ desktopApi, thread, initialHistoryLimit: 2 }),
  );
  await act(async () => {});

  return {
    result: hook.result,
    reads,
    setNow: (value: number) => {
      now = value;
    },
    emit: (method: string, notifParams: Record<string, unknown>) =>
      emitListener({
        backend: params.backend,
        notification: {
          method,
          params: { threadId: "order-thread", ...notifParams },
        } as AgentEvent["notification"],
      }),
    close: () => {
      for (const read of reads.splice(0)) {
        read.resolve(read.response);
      }
      hook.unmount();
      clockSpy.mockRestore();
    },
  };
}

function entryKeys(entries: readonly AppServerThreadEntry[]): string[] {
  return Array.from(entries).flatMap((entry) =>
    entry.type === "activity"
      ? entry.details.map((detail) => detail.id)
      : [entry.id],
  );
}

describe("useThreadSessionState transcript ordering regressions (MBT shrunk counterexamples)", () => {
  it("keeps a managed review start card above its tool calls", async () => {
    const session = await mountSession({
      backend: "acp:antigravity",
      supportsPagination: false,
      snapshot: () => [],
    });
    try {
      act(() => {
        session.result.current.addOptimisticReviewEntry("Review pull request #683");
        session.emit("turn/started", {
          turn: { id: "review-1", status: "in_progress", startedAt: BASE_NOW },
        });
        session.emit("item/completed", {
          turnId: "review-1",
          item: {
            id: "managed-review:review-1:started",
            type: "enteredReviewMode",
            review: "Review pull request #683",
            createdAt: BASE_NOW,
          },
        });
        session.emit("item/started", {
          turnId: "review-1",
          item: { id: "rev-tc-0", type: "commandExecution", command: "git diff", status: "inProgress" },
        });
        session.emit("item/completed", {
          turnId: "review-1",
          item: { id: "rev-tc-0", type: "commandExecution", command: "git diff", status: "completed", exitCode: 0 },
        });
      });

      expect(entryKeys(session.result.current.entries)).toEqual([
        "managed-review:review-1:started",
        "rev-tc-0",
      ]);
    } finally {
      session.close();
    }
  });

  it("keeps a review start card above its review result under clock skew", async () => {
    const session = await mountSession({
      backend: "codex",
      supportsPagination: true,
      snapshot: () => [],
    });
    try {
      act(() => {
        session.result.current.addOptimisticReviewEntry("Review pull request #683");
        session.emit("turn/started", {
          turn: { id: "review-1", status: "in_progress", startedAt: BASE_NOW },
        });
        session.emit("item/completed", {
          turnId: "review-1",
          item: {
            id: "managed-review:review-1:started",
            type: "enteredReviewMode",
            review: "Review pull request #683",
            createdAt: BASE_NOW,
          },
        });
        session.setNow(BASE_NOW - 200);
        session.emit("item/completed", {
          turnId: "review-1",
          item: {
            id: "managed-review:review-1:result",
            type: "exitedReviewMode",
            review: "No findings.",
            createdAt: BASE_NOW - 200,
          },
        });
        session.emit("turn/completed", {
          turnId: "review-1",
          turn: { id: "review-1", status: "completed", completedAt: BASE_NOW - 200 },
        });
      });

      expect(entryKeys(session.result.current.entries)).toEqual([
        "managed-review:review-1:started",
        "managed-review:review-1:result",
      ]);
    } finally {
      session.close();
    }
  });

  it("keeps live tool calls above a subsequent mid-turn steer message", async () => {
    const session = await mountSession({
      backend: "acp:antigravity",
      supportsPagination: false,
      snapshot: () => [],
    });
    try {
      act(() => {
        session.emit("turn/started", {
          turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
        });
        session.emit("item/started", {
          turnId: "turn-1",
          item: { id: "tc-1", type: "commandExecution", command: "pnpm test", status: "inProgress" },
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: { id: "tc-1", type: "commandExecution", command: "pnpm test", status: "completed", exitCode: 0 },
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "user:turn-1:steer:1",
            type: "userMessage",
            steered: true,
            content: [{ type: "text", text: "also check lint" }],
            createdAt: BASE_NOW,
          },
        });
      });

      expect(entryKeys(session.result.current.entries)).toEqual([
        "tc-1",
        "user:turn-1:steer:1",
      ]);
    } finally {
      session.close();
    }
  });

  it("keeps an ACP tool call after an untimed final reply across lagging non-paginated reads", async () => {
    let entries: AppServerThreadEntry[] = [];
    let active = false;
    const session = await mountSession({
      backend: "acp:antigravity",
      supportsPagination: false,
      snapshot: () => entries,
      isActive: () => active,
    });
    try {
      act(() => {
        void session.result.current.reload();
        active = true;
        session.emit("turn/started", {
          turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
        });
        session.emit("item/agentMessage/delta", {
          turnId: "turn-1",
          itemId: "assistant:turn-1:0",
          delta: "Running tests now.",
          phase: "final",
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "assistant:turn-1:0",
            type: "agentMessage",
            text: "Running tests now.",
            phase: "final",
          },
        });
        entries = [
          {
            type: "message",
            id: "assistant:turn-1:0",
            role: "assistant",
            phase: "final",
            text: "Running tests now.",
            turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
          },
        ];
      });

      // Stale empty read resolves after assistant:turn-1:0 arrived live.
      await act(async () => {
        const stale = session.reads.shift()!;
        stale.resolve(stale.response);
      });

      act(() => {
        void session.result.current.reload();
        session.emit("item/started", {
          turnId: "turn-1",
          item: { id: "tc-1", type: "commandExecution", command: "pnpm test", status: "inProgress" },
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: { id: "tc-1", type: "commandExecution", command: "pnpm test", status: "completed", exitCode: 0 },
        });
        active = false;
        session.emit("turn/completed", {
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", completedAt: BASE_NOW },
        });
      });

      await act(async () => {
        const read2 = session.reads.shift()!;
        read2.resolve(read2.response);
      });

      expect(entryKeys(session.result.current.entries)).toEqual([
        "assistant:turn-1:0",
        "tc-1",
      ]);
    } finally {
      session.close();
    }
  });

  it("does not duplicate split durable-diff live-tools buckets on paginated replay", async () => {
    let entries: AppServerThreadEntry[] = [];
    const session = await mountSession({
      backend: "codex",
      supportsPagination: true,
      snapshot: () => entries,
    });
    try {
      act(() => {
        session.emit("turn/started", {
          turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
        });
        void session.result.current.reload();
        session.emit("item/started", {
          turnId: "turn-1",
          item: { id: "tc-0", type: "commandExecution", command: "pnpm test", status: "inProgress" },
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: { id: "tc-0", type: "commandExecution", command: "pnpm test", status: "completed", exitCode: 0 },
        });
        session.emit("item/started", {
          turnId: "turn-1",
          item: {
            id: "tc-1",
            type: "commandExecution",
            acpFileEdit: true,
            title: "Edited a.ts",
            path: "a.ts",
            command: "edit a.ts",
            fileDiff: { kind: "update", diff: "diff tc-1", additions: 1, removals: 0 },
            status: "inProgress",
          },
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "tc-1",
            type: "commandExecution",
            acpFileEdit: true,
            title: "Edited a.ts",
            path: "a.ts",
            command: "edit a.ts",
            fileDiff: { kind: "update", diff: "diff tc-1", additions: 1, removals: 0 },
            status: "completed",
          },
        });
      });

      // Empty read resolves first, retaining live-tools bucket as a durable diff row.
      await act(async () => {
        const read1 = session.reads.shift()!;
        read1.resolve(read1.response);
      });

      const turn = { id: "turn-1", status: "completed" as const, startedAt: BASE_NOW, completedAt: BASE_NOW + 10 };
      entries = [
        {
          type: "activity",
          id: "act-tc-0",
          summary: "Ran pnpm test",
          status: "completed",
          createdAt: BASE_NOW,
          details: [{ id: "tc-0", kind: "command", label: "pnpm test", status: "completed" }],
          turn,
        },
        {
          type: "activity",
          id: "act-tc-1",
          summary: "Edited a.ts",
          status: "completed",
          createdAt: BASE_NOW,
          details: [
            {
              id: "tc-1",
              kind: "write",
              path: "a.ts",
              label: "Edited a.ts",
              status: "completed",
              fileDiff: { kind: "update", diff: "diff tc-1", additions: 1, removals: 0 },
            },
          ],
          turn,
        },
      ];

      act(() => {
        void session.result.current.reload();
        session.emit("turn/completed", { turnId: "turn-1", turn });
      });

      while (session.reads.length > 0) {
        await act(async () => {
          const read = session.reads.shift()!;
          read.resolve(read.response);
        });
      }

      expect(entryKeys(session.result.current.entries)).toEqual(["tc-0", "tc-1"]);
    } finally {
      session.close();
    }
  });

  it("keeps a new optimistic send after prior turns under clock skew and above later steers when echo is missed", async () => {
    const session = await mountSession({
      backend: "acp:antigravity",
      supportsPagination: false,
      snapshot: () => [],
    });
    try {
      let pendingId!: string;
      act(() => {
        session.emit("turn/started", {
          turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "assistant:turn-1:0",
            type: "agentMessage",
            text: "Done.",
            phase: "final",
            createdAt: BASE_NOW,
          },
        });
        session.setNow(BASE_NOW - 200);
        session.emit("turn/completed", {
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", completedAt: BASE_NOW - 200 },
        });
        pendingId = session.result.current.addOptimisticUserMessage("next prompt");
      });

      expect(entryKeys(session.result.current.entries)).toEqual([
        "assistant:turn-1:0",
        pendingId,
      ]);

      act(() => {
        session.emit("turn/started", {
          turn: { id: "turn-2", status: "in_progress", startedAt: BASE_NOW - 200 },
        });
        session.emit("item/completed", {
          turnId: "turn-2",
          item: {
            id: "user:turn-2:steer:1",
            type: "userMessage",
            steered: true,
            content: [{ type: "text", text: "steer text" }],
            createdAt: BASE_NOW - 200,
          },
        });
      });

      expect(entryKeys(session.result.current.entries)).toEqual([
        "assistant:turn-1:0",
        pendingId,
        "user:turn-2:steer:1",
      ]);
    } finally {
      session.close();
    }
  });

  it("propagates coalesced live-tools sequence onto split replay activities under clock skew", async () => {
    const turnInProgress = { id: "turn-1", status: "in_progress" as const, startedAt: BASE_NOW };
    let entries: AppServerThreadEntry[] = [];
    const session = await mountSession({
      backend: "codex",
      supportsPagination: true,
      snapshot: () => entries,
    });
    try {
      act(() => {
        session.emit("turn/started", { turn: turnInProgress });
        for (const id of ["tc-0", "tc-1"]) {
          session.emit("item/started", {
            turnId: "turn-1",
            item: { id, type: "commandExecution", command: `echo ${id}`, status: "inProgress" },
          });
          session.emit("item/completed", {
            turnId: "turn-1",
            item: { id, type: "commandExecution", command: `echo ${id}`, status: "completed", exitCode: 0 },
          });
        }
        entries = [
          {
            type: "activity",
            id: "act-tc-0",
            summary: "echo tc-0",
            status: "completed",
            createdAt: BASE_NOW,
            details: [{ id: "tc-0", kind: "command", label: "echo tc-0", status: "completed" }],
            turn: turnInProgress,
          },
          {
            type: "activity",
            id: "act-tc-1",
            summary: "echo tc-1",
            status: "completed",
            createdAt: BASE_NOW,
            details: [{ id: "tc-1", kind: "command", label: "echo tc-1", status: "completed" }],
            turn: turnInProgress,
          },
        ];
        session.setNow(BASE_NOW - 200);
        void session.result.current.reload();
        session.emit("item/agentMessage/delta", {
          turnId: "turn-1",
          itemId: "assistant:turn-1:2",
          delta: "Thinking after tools",
          phase: "commentary",
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "assistant:turn-1:2",
            type: "agentMessage",
            text: "Thinking after tools",
            phase: "commentary",
          },
        });
        session.emit("turn/completed", {
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", completedAt: BASE_NOW - 200 },
        });
      });

      while (session.reads.length > 0) {
        await act(async () => {
          const read = session.reads.shift()!;
          read.resolve(read.response);
        });
      }

      expect(entryKeys(session.result.current.entries)).toEqual([
        "tc-0",
        "tc-1",
        "assistant:turn-1:2",
      ]);
    } finally {
      session.close();
    }
  });

  it("does not let a same-text steer steal an un-echoed opening prompt or match a non-steered replay prompt", async () => {
    let entries: AppServerThreadEntry[] = [];
    const session = await mountSession({
      backend: "acp:antigravity",
      supportsPagination: false,
      snapshot: () => entries,
    });
    try {
      let optId!: string;
      act(() => {
        optId = session.result.current.addOptimisticUserMessage("continue");
        session.emit("turn/started", {
          turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
        });
        entries = [
          {
            type: "message",
            id: "user:turn-1",
            role: "user",
            text: "continue",
            createdAt: BASE_NOW,
            turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
          },
        ];
        void session.result.current.reload();
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "user:turn-1:steer:1",
            type: "userMessage",
            steered: true,
            content: [{ type: "text", text: "first steer" }],
            createdAt: BASE_NOW,
          },
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "user:turn-1:steer:2",
            type: "userMessage",
            steered: true,
            content: [{ type: "text", text: "continue" }],
            createdAt: BASE_NOW,
          },
        });
        // Subsequent reads (after turn completion) include both accepted steers;
        // the earlier in-flight read still holds only the lagging [user:turn-1].
        entries = [
          ...entries,
          {
            type: "message",
            id: "user:turn-1:steer:1",
            role: "user",
            text: "first steer",
            createdAt: BASE_NOW,
            turn: { id: "turn-1", status: "completed", startedAt: BASE_NOW, completedAt: BASE_NOW },
          },
          {
            type: "message",
            id: "user:turn-1:steer:2",
            role: "user",
            text: "continue",
            createdAt: BASE_NOW,
            turn: { id: "turn-1", status: "completed", startedAt: BASE_NOW, completedAt: BASE_NOW },
          },
        ];
      });

      expect(entryKeys(session.result.current.entries)).toEqual([
        optId,
        "user:turn-1:steer:1",
        "user:turn-1:steer:2",
      ]);

      act(() => {
        session.emit("turn/completed", {
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", completedAt: BASE_NOW },
        });
      });

      // Resolve the lagging read first (which only held [user:turn-1]) and
      // confirm it matches user:turn-1 to optId, not to user:turn-1:steer:2.
      await act(async () => {
        const laggingRead = session.reads.shift()!;
        laggingRead.resolve(laggingRead.response);
      });
      expect(entryKeys(session.result.current.entries)).toEqual([
        "user:turn-1",
        "user:turn-1:steer:1",
        "user:turn-1:steer:2",
      ]);

      while (session.reads.length > 0) {
        await act(async () => {
          const read = session.reads.shift()!;
          read.resolve(read.response);
        });
      }

      expect(entryKeys(session.result.current.entries)).toEqual([
        "user:turn-1",
        "user:turn-1:steer:1",
        "user:turn-1:steer:2",
      ]);
    } finally {
      session.close();
    }
  });

  it("does not let a first-in-turn or post-promotion same-text steer steal an un-echoed opening prompt", async () => {
    const entries: AppServerThreadEntry[] = [];
    const session = await mountSession({
      backend: "acp:antigravity",
      supportsPagination: false,
      snapshot: () => entries,
    });
    try {
      // Case 1: first-in-turn steer arrives before any assistant/tool entry in turn-1.
      let optTurn1!: string;
      act(() => {
        optTurn1 = session.result.current.addOptimisticUserMessage("continue");
        session.emit("turn/started", {
          turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "user:turn-1:steer:1",
            type: "userMessage",
            steered: true,
            content: [{ type: "text", text: "continue" }],
            createdAt: BASE_NOW + 10,
          },
        });
      });

      expect(entryKeys(session.result.current.entries)).toEqual([
        optTurn1,
        "user:turn-1:steer:1",
      ]);

      // Case 2: opening prompt was promoted into response.replay.entries by an
      // assistant completion before a same-text steer arrives.
      let optTurn2!: string;
      act(() => {
        session.emit("turn/completed", {
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed", completedAt: BASE_NOW + 20 },
        });
        optTurn2 = session.result.current.addOptimisticUserMessage("continue");
        session.emit("turn/started", {
          turn: { id: "turn-2", status: "in_progress", startedAt: BASE_NOW + 30 },
        });
        session.emit("item/completed", {
          turnId: "turn-2",
          item: {
            id: "assistant:turn-2:1",
            type: "agentMessage",
            text: "Working on it",
            phase: "commentary",
            createdAt: BASE_NOW + 35,
          },
        });
        session.emit("item/completed", {
          turnId: "turn-2",
          item: {
            id: "user:turn-2:steer:1",
            type: "userMessage",
            steered: true,
            content: [{ type: "text", text: "continue" }],
            createdAt: BASE_NOW + 40,
          },
        });
      });

      expect(entryKeys(session.result.current.entries)).toEqual([
        optTurn1,
        "user:turn-1:steer:1",
        optTurn2,
        "assistant:turn-2:1",
        "user:turn-2:steer:1",
      ]);
    } finally {
      session.close();
    }
  });

  it("does not let a same-text live steer stamp an opening prompt during an active-turn lagging read", async () => {
    let entries: AppServerThreadEntry[] = [];
    const session = await mountSession({
      backend: "acp:antigravity",
      supportsPagination: false,
      snapshot: () => entries,
    });
    try {
      act(() => {
        session.result.current.addOptimisticUserMessage("continue");
        session.emit("turn/started", {
          turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
        });
        entries = [
          {
            type: "message",
            id: "user:turn-1",
            role: "user",
            text: "continue",
            createdAt: BASE_NOW,
            turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
          },
        ];
        void session.result.current.reload();
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "user:turn-1:steer:1",
            type: "userMessage",
            steered: true,
            content: [{ type: "text", text: "first steer" }],
            createdAt: BASE_NOW + 10,
          },
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "user:turn-1:steer:2",
            type: "userMessage",
            steered: true,
            content: [{ type: "text", text: "continue" }],
            createdAt: BASE_NOW + 50,
          },
        });
      });

      // Resolve lagging read while turn-1 is STILL in progress.
      await act(async () => {
        const laggingRead = session.reads.shift()!;
        laggingRead.resolve(laggingRead.response);
      });

      expect(entryKeys(session.result.current.entries)).toEqual([
        "user:turn-1",
        "user:turn-1:steer:1",
        "user:turn-1:steer:2",
      ]);
    } finally {
      session.close();
    }
  });

  it("preserves steered and rendererSequence markers across readThread hydration so same-text steers cannot prune opening prompts", async () => {
    let entries: AppServerThreadEntry[] = [];
    const session = await mountSession({
      backend: "acp:antigravity",
      supportsPagination: false,
      snapshot: () => entries,
    });
    try {
      let optId!: string;
      act(() => {
        optId = session.result.current.addOptimisticUserMessage("continue");
        session.emit("turn/started", {
          turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
        });
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "user:turn-1:steer:1",
            type: "userMessage",
            steered: true,
            content: [{ type: "text", text: "continue" }],
            createdAt: BASE_NOW + 20,
          },
        });
        // A mid-turn snapshot containing the persisted steer before the opening prompt is echoed.
        entries = [
          {
            type: "message",
            id: "user:turn-1:steer:1",
            role: "user",
            text: "continue",
            createdAt: BASE_NOW + 20,
            turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
          },
        ];
        void session.result.current.reload();
      });

      await act(async () => {
        const read1 = session.reads.shift()!;
        read1.resolve(read1.response);
      });

      // Opening optimistic prompt must survive hydration and stay ahead of the steer.
      expect(entryKeys(session.result.current.entries)).toEqual([
        optId,
        "user:turn-1:steer:1",
      ]);

      // A subsequent lagging snapshot with only the opening prompt while live
      // turn activity continues must still recognize user:turn-1:steer:1 as
      // steered and refuse to match user:turn-1 against it.
      act(() => {
        entries = [
          {
            type: "message",
            id: "user:turn-1",
            role: "user",
            text: "continue",
            createdAt: BASE_NOW,
            turn: { id: "turn-1", status: "in_progress", startedAt: BASE_NOW },
          },
        ];
        void session.result.current.reload();
        session.emit("item/completed", {
          turnId: "turn-1",
          item: {
            id: "assistant:turn-1:1",
            type: "agentMessage",
            text: "Continuing",
            phase: "commentary",
            createdAt: BASE_NOW + 30,
          },
        });
      });

      await act(async () => {
        const read2 = session.reads.shift()!;
        read2.resolve(read2.response);
      });

      expect(entryKeys(session.result.current.entries)).toEqual([
        "user:turn-1",
        "user:turn-1:steer:1",
        "assistant:turn-1:1",
      ]);
    } finally {
      session.close();
    }
  });
});
