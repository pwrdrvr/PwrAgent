import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type {
  AppServerPendingRequestNotification,
  AppServerReadThreadResponse,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { updateMcpFieldValue } from "../../features/thread-detail/mcp-elicitation";
import { usePendingRequestControls } from "../../features/thread-detail/usePendingRequestControls";
import type { DesktopApi } from "../desktop-api";
import { useThreadSessionState } from "../useThreadSessionState";

const thread: NavigationThreadSummary = {
  id: "demo-thread",
  source: "codex",
  title: "Demo",
  titleSource: "explicit",
  inbox: { inInbox: false },
  linkedDirectories: [],
  updatedAt: 1,
  federation: {
    instanceLabel: "Demo peer",
    capabilities: ["thread_detail", "pending_request_control"],
    ref: { backend: "codex", threadId: "demo-thread", target: { scope: "remote", instanceId: "demo-peer" } },
  },
};

function approval(requestId: string): AppServerPendingRequestNotification {
  return {
    method: "item/commandExecution/requestApproval",
    params: { threadId: thread.id, turnId: "demo-turn", requestId, command: "ls demo" },
  };
}

function form(requestId: string, defaultValue: string): AppServerPendingRequestNotification {
  return {
    method: "mcpServer/elicitation/request",
    params: {
      threadId: thread.id,
      turnId: "demo-turn",
      requestId,
      serverName: "demo",
      mode: "form",
      message: "Name the demo",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string", default: defaultValue } },
      },
    },
  };
}

async function mountSession(initial: AppServerPendingRequestNotification) {
  const reads: Array<(response: AppServerReadThreadResponse) => void> = [];
  const desktopApi: DesktopApi = {
    readThread: vi.fn(() => new Promise<AppServerReadThreadResponse>((resolve) => reads.push(resolve))),
  };
  const hook = renderHook(() => useThreadSessionState({ desktopApi, thread }));

  async function deliver(index: number, pendingRequest: AppServerPendingRequestNotification) {
    await act(async () => reads[index]!({
      backend: thread.source,
      threadId: thread.id,
      fetchedAt: index + 1,
      threadStatus: "active",
      replay: { entries: [], messages: [], pagination: { supportsPagination: false, hasPreviousPage: false } },
      pendingRequest,
    }));
  }

  await deliver(0, initial);
  return { ...hook, deliver };
}

// The owner takes the snapshot at read start. Regardless of delivery order,
// an accepted request stays resolved and a later fresh request is actionable.
async function checkApprovalOrdering(requestId: string, acceptBeforeDelivery: boolean) {
  const request = approval(requestId);
  const { result, deliver, unmount } = await mountSession(request);
  try {
    expect(result.current.pendingRequest).toEqual(request);
    act(() => { void result.current.reload(); });
    if (acceptBeforeDelivery) {
      act(() => result.current.clearPendingRequest(requestId, "Thinking"));
    }
    await deliver(1, request);
    if (!acceptBeforeDelivery) {
      act(() => result.current.clearPendingRequest(requestId, "Thinking"));
    }
    expect(result.current.pendingRequest).toBeUndefined();
    expect(result.current.pendingStatusText).toBe("Thinking");

    const next = approval(`${requestId}-next`);
    act(() => { void result.current.reload(); });
    await deliver(2, next);
    expect(result.current.pendingRequest).toEqual(next);
  } finally {
    unmount();
  }
}

it("does not reopen an approval when its pre-acceptance snapshot arrives late", async () => {
  await checkApprovalOrdering("approval-1", true);
});

it("agrees with the owner across approval and snapshot delivery orderings", async () => {
  await fc.assert(fc.asyncProperty(fc.uuid(), fc.boolean(), checkApprovalOrdering), { numRuns: 25 });
});

async function checkFormRefresh(input: string, sameRequest: boolean) {
  const initial = form("form-1", "Owner default");
  const { result, deliver, unmount } = await mountSession(initial);
  try {
    act(() => { void result.current.reload(); });
    act(() => result.current.updatePendingMcpInteraction("form-1", (state) =>
      updateMcpFieldValue(state, "name", input),
    ));
    await deliver(1, sameRequest ? initial : form("form-2", "Next default"));
    expect(result.current.pendingMcpInteraction?.form?.fields).toMatchObject([
      { key: "name", value: sameRequest ? input : "Next default" },
    ]);
  } finally {
    unmount();
  }
}

it("keeps typed MCP answers when the same request refreshes", async () => {
  await checkFormRefresh("My draft", true);
});

it("preserves MCP drafts across refreshes only for the same request", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), fc.boolean(), checkFormRefresh), { numRuns: 25 });
});

async function checkRejectionOrdering(rejectBeforeResolution: boolean, replacement: boolean) {
  const pendingRequest = approval("approval-1");
  let reject!: (error: Error) => void;
  const desktopApi: DesktopApi = {
    submitServerRequest: () => new Promise((_, rejectResponse) => { reject = rejectResponse; }),
  };
  const hook = renderHook(
    ({ request }: { request?: AppServerPendingRequestNotification }) => usePendingRequestControls({
      desktopApi, thread, pendingRequest: request, clearPendingRequest: vi.fn(),
    }),
    { initialProps: { request: pendingRequest } as { request?: AppServerPendingRequestNotification } },
  );
  try {
    act(() => {
      void hook.result.current.transcriptControls.onRespondToPendingRequest({
        id: "accept", label: "Approve once", decision: "accept", style: "primary",
        fallbackText: "Accept", response: { decision: "accept" },
      });
    });
    const rejectResponse = async () => {
      await act(async () => reject(new Error("Owner denied the response")));
    };
    if (rejectBeforeResolution) {
      await rejectResponse();
      expect(hook.result.current.pendingRequestError).toBe("Owner denied the response");
    }
    hook.rerender({ request: replacement ? approval("approval-2") : undefined });
    if (!rejectBeforeResolution) {
      await rejectResponse();
    }
    expect(hook.result.current.pendingRequestError).toBeUndefined();
  } finally {
    hook.unmount();
  }
}

it.each([false, true])("hides a resolved request’s error (rejected before resolution: %s)", async (before) => {
  await checkRejectionOrdering(before, false);
});

it("only displays a submission error while its request owns the interaction", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), checkRejectionOrdering), { numRuns: 25 });
});
