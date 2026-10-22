import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent, OperatorRequestsChangedEvent } from "@pwragent/shared";
import {
  OPERATOR_QUESTIONS_LIST_DISMISSED_CHANNEL, OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL,
  OPERATOR_REQUESTS_DISMISS_QUESTION_CHANNEL,
} from "../../shared/ipc";

const fixture = vi.hoisted(() => {
  const target = { scope: "remote" as const, instanceId: "owner" };
  return {
    target,
    windows: [undefined, target, { scope: "remote" as const, instanceId: "other" }].map((target) => ({
      target, isDestroyed: () => false, send: vi.fn(),
    })),
    handlers: new Map<string, (event: unknown, request: unknown) => Promise<unknown>>(),
    remote: vi.fn(async () => ["question-1"]), publish: vi.fn(), localDismiss: vi.fn(), localList: vi.fn(() => []),
    broadcast: undefined as ((event: OperatorRequestsChangedEvent) => void) | undefined,
    remoteListener: undefined as ((event: AgentEvent) => void) | undefined,
    peerListener: undefined as (() => void) | undefined,
  };
});

vi.mock("electron", () => ({ ipcMain: {
  removeHandler: (channel: string) => fixture.handlers.delete(channel),
  handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) => fixture.handlers.set(channel, handler),
} }));
vi.mock("../app-server/backend-registry", () => ({ getDesktopBackendRegistry: () => ({}) }));
vi.mock("../state/app-state", () => ({ getAppStateDb: () => ({}) }));
vi.mock("../operator-requests/operator-request-store", () => ({ OperatorRequestStore: class {} }));
vi.mock("../operator-requests/operator-request-service", () => ({ OperatorRequestService: class {
  constructor(options: { broadcast: (event: OperatorRequestsChangedEvent) => void }) { fixture.broadcast = options.broadcast; }
  start() {}
  stop() {}
} }));
vi.mock("../operator-requests/operator-request-runtime", () => ({
  installOperatorRequestService: () => {},
  localOperatorQuestionOperations: { dismiss: fixture.localDismiss, listDismissed: fixture.localList },
}));
vi.mock("../federation/federation-runtime", () => ({ getDesktopFederationRuntime: () => ({
  requestOperatorQuestionOperation: fixture.remote, publishOperatorQuestionsChanged: fixture.publish,
  onRemoteBackendEvent: (listener: (event: AgentEvent) => void) => { fixture.remoteListener = listener; return () => {}; },
  onPeerStatusChanged: (listener: () => void) => { fixture.peerListener = listener; return () => {}; },
}) }));
vi.mock("../window-channels", () => ({
  subscribersForChannel: () => fixture.windows,
  federationTargetForChannelSubscriber: (sender: { target: unknown }) => sender.target,
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ warn: vi.fn() }) }));

import { registerOperatorRequestIpcHandlers } from "../ipc/operator-requests-ipc";

beforeEach(() => { vi.clearAllMocks(); registerOperatorRequestIpcHandlers(); });

const question = { backend: "codex", threadId: "thread-1", messageId: "question-1" };

describe("operator question IPC ownership", () => {
  it.each([false, true])("routes a dismissal and its saved state to the owner (remote window: %s)", async (remoteWindow) => {
    const sender = fixture.windows[remoteWindow ? 1 : 0];
    const request = { ...question, ...(!remoteWindow ? { federationTarget: fixture.target } : {}) };
    await fixture.handlers.get(OPERATOR_REQUESTS_DISMISS_QUESTION_CHANNEL)!({ sender }, request);
    expect(fixture.remote).toHaveBeenCalledWith(fixture.target, "dismiss", question);
    expect(fixture.localDismiss).not.toHaveBeenCalled();
    const response = await fixture.handlers.get(OPERATOR_QUESTIONS_LIST_DISMISSED_CHANNEL)!({ sender }, request);
    expect(response).toEqual(["question-1"]);
    expect(fixture.remote).toHaveBeenLastCalledWith(fixture.target, "listDismissed", question);
    expect(fixture.localList).not.toHaveBeenCalled();
  });

  it("never falls back to a colliding local question after an owner rejects the request", async () => {
    fixture.remote.mockRejectedValueOnce(new Error("Update the owner."));
    await expect(fixture.handlers.get(OPERATOR_REQUESTS_DISMISS_QUESTION_CHANNEL)!(
      { sender: fixture.windows[0] }, { ...question, federationTarget: fixture.target },
    )).rejects.toThrow("Update the owner.");
    expect(fixture.localDismiss).not.toHaveBeenCalled();
  });

  it("serves local requests and publishes scoped owner changes to local windows and federation", async () => {
    await fixture.handlers.get(OPERATOR_REQUESTS_DISMISS_QUESTION_CHANNEL)!({ sender: fixture.windows[0] }, question);
    expect(fixture.localDismiss).toHaveBeenCalledWith(question);
    fixture.broadcast!({ reason: "questions", backend: "codex", threadId: "thread-1" });
    expect(fixture.publish).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-1" });
    expect(fixture.windows[0]!.send).toHaveBeenCalledOnce();
    expect(fixture.windows[1]!.send).not.toHaveBeenCalled();
  });

  it("refreshes the correct viewers on remote changes, stream recovery and reconnection", () => {
    fixture.remoteListener!({ backend: "codex", federationTarget: fixture.target,
      notification: { method: "thread/operatorQuestions/changed", params: { backend: "codex", threadId: "thread-1" } },
    });
    for (const window of fixture.windows.slice(0, 2)) {
      expect(window.send).toHaveBeenCalledWith(OPERATOR_REQUESTS_CHANGED_EVENT_CHANNEL, {
        reason: "questions", backend: "codex", threadId: "thread-1", federationTarget: fixture.target,
      });
    }
    expect(fixture.windows[2]!.send).not.toHaveBeenCalled();
    fixture.remoteListener!({ backend: "codex", federationTarget: fixture.target,
      notification: { method: "federation/eventStream/changed", params: {} },
    } as AgentEvent);
    expect(fixture.windows[1]!.send).toHaveBeenCalledTimes(2);
    fixture.peerListener!();
    expect(fixture.windows[1]!.send).toHaveBeenCalledTimes(3);
  });
});
