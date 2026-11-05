import { ipcMain } from "electron";
import type {
  CancelThreadHandoffRequest,
  HandoffInstanceThreadRequest,
  HandoffInstanceThreadResult,
  RetryThreadHandoffNowRequest,
  ThreadHandoffProgress,
} from "@pwragent/shared";
import { isFederationInstanceId } from "@pwragent/shared";
import {
  FEDERATION_CANCEL_HANDOFF_THREAD_CHANNEL,
  FEDERATION_HANDOFF_THREAD_CHANNEL,
  FEDERATION_HANDOFF_THREAD_PROGRESS_CHANNEL,
  FEDERATION_RETRY_HANDOFF_THREAD_NOW_CHANNEL,
  THREAD_HANDOFF_CANCELLED_MESSAGE,
} from "../../shared/ipc";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import {
  THREAD_HANDOFF_RETRY_NOW_EVENT,
  type ThreadHandoffSendOptions,
} from "../federation/thread-instance-handoff-service";

/** Byte updates arrive once per chunk; a few frames a second is plenty. */
const PROGRESS_INTERVAL_MS = 150;
const HANDOFF_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type SendHandoff = (
  request: HandoffInstanceThreadRequest,
  options: ThreadHandoffSendOptions,
) => Promise<HandoffInstanceThreadResult>;

type Sender = {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, progress: ThreadHandoffProgress) => void;
  once: (event: "destroyed", listener: () => void) => void;
};

type Handoff = {
  controller: AbortController;
  retryNow: EventTarget;
  senderId: number;
};

/**
 * The desktop dialog's handoffs. Each is owned by the window that started it:
 * only that window gets its progress and can cancel it or skip a reconnect
 * wait. Closing the window cancels whatever can still be cancelled; a handoff
 * already importing on the receiver runs to its result either way.
 */
export function createThreadHandoffController(options: {
  send: SendHandoff;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const handoffs = new Map<string, Handoff>();
  const watchedSenders = new Set<number>();

  const cancelSender = (senderId: number): void => {
    watchedSenders.delete(senderId);
    for (const handoff of handoffs.values()) {
      if (handoff.senderId === senderId) handoff.controller.abort();
    }
  };

  return {
    async send(sender: Sender, request: HandoffInstanceThreadRequest): Promise<HandoffInstanceThreadResult> {
      // The desktop dialog sends only threads this instance owns; a
      // remote-owned source stays with the agent tool, which names it.
      if (
        !request
        || typeof request.sourceThreadId !== "string"
        || !request.sourceThreadId
        || !isFederationInstanceId(request.targetInstanceId)
        || (request.operation !== "copy" && request.operation !== "move")
        || (
          request.targetRepositoryPath !== undefined
          && typeof request.targetRepositoryPath !== "string"
        )
        || typeof request.handoffId !== "string"
        || !HANDOFF_ID.test(request.handoffId)
      ) {
        throw new Error("Invalid thread handoff request");
      }
      const handoffId = request.handoffId;
      if (handoffs.has(handoffId)) throw new Error("This handoff is already running.");
      if (!watchedSenders.has(sender.id)) {
        watchedSenders.add(sender.id);
        const senderId = sender.id;
        sender.once("destroyed", () => cancelSender(senderId));
      }
      const handoff: Handoff = {
        controller: new AbortController(),
        retryNow: new EventTarget(),
        senderId: sender.id,
      };
      handoffs.set(handoffId, handoff);
      let last: ThreadHandoffProgress | undefined;
      let lastSentAt = Number.NEGATIVE_INFINITY;
      const report = (progress: ThreadHandoffProgress): void => {
        const at = now();
        // A change of step, link or cancelability always goes out, as do the
        // first and last byte counts of a send. Only mid-send byte counts wait.
        const bytesOnly =
          last !== undefined
          && last.phase === progress.phase
          && last.link === progress.link
          && last.cancelable === progress.cancelable
          && last.resumedFromBytes === progress.resumedFromBytes
          && progress.bytesCommitted !== undefined
          && progress.bytesCommitted !== 0
          && progress.bytesCommitted !== progress.bytesTotal;
        if (bytesOnly && at - lastSentAt < PROGRESS_INTERVAL_MS) return;
        last = progress;
        lastSentAt = at;
        if (sender.isDestroyed()) return;
        sender.send(FEDERATION_HANDOFF_THREAD_PROGRESS_CHANNEL, progress);
      };
      try {
        return await options.send(
          {
            sourceThreadId: request.sourceThreadId,
            targetInstanceId: request.targetInstanceId,
            operation: request.operation,
            handoffId,
            ...(request.targetRepositoryPath?.trim()
              ? { targetRepositoryPath: request.targetRepositoryPath.trim() }
              : {}),
          },
          {
            signal: handoff.controller.signal,
            retryNow: handoff.retryNow,
            onProgress: report,
          },
        );
      } catch (error) {
        // Only the abort itself is a cancel. An abort after the import began is
        // ignored by the sender, so a later failure there is still a failure.
        const signal = handoff.controller.signal;
        if (signal.aborted && (error === signal.reason || (error instanceof Error && error.name === "AbortError"))) {
          throw new Error(THREAD_HANDOFF_CANCELLED_MESSAGE);
        }
        throw error;
      } finally {
        handoffs.delete(handoffId);
      }
    },
    cancel(senderId: number, request: CancelThreadHandoffRequest): void {
      if (typeof request?.handoffId !== "string") return;
      const handoff = handoffs.get(request.handoffId);
      if (handoff?.senderId === senderId) handoff.controller.abort();
    },
    retryNow(senderId: number, request: RetryThreadHandoffNowRequest): void {
      if (typeof request?.handoffId !== "string") return;
      const handoff = handoffs.get(request.handoffId);
      if (handoff?.senderId === senderId) {
        handoff.retryNow.dispatchEvent(new Event(THREAD_HANDOFF_RETRY_NOW_EVENT));
      }
    },
    dispose(): void {
      for (const handoff of handoffs.values()) handoff.controller.abort();
      handoffs.clear();
      watchedSenders.clear();
    },
  };
}

let controller: ReturnType<typeof createThreadHandoffController> | undefined;

export function registerThreadHandoffIpc(): void {
  disposeThreadHandoffIpc();
  const active = createThreadHandoffController({
    send: async (request, sendOptions) =>
      await getDesktopFederationRuntime().handoffInstanceThread(request, undefined, sendOptions),
  });
  controller = active;
  ipcMain.handle(
    FEDERATION_HANDOFF_THREAD_CHANNEL,
    async (event, request: HandoffInstanceThreadRequest): Promise<HandoffInstanceThreadResult> =>
      await active.send(event.sender, request),
  );
  ipcMain.handle(
    FEDERATION_CANCEL_HANDOFF_THREAD_CHANNEL,
    (event, request: CancelThreadHandoffRequest): void => {
      active.cancel(event.sender.id, request);
    },
  );
  ipcMain.handle(
    FEDERATION_RETRY_HANDOFF_THREAD_NOW_CHANNEL,
    (event, request: RetryThreadHandoffNowRequest): void => {
      active.retryNow(event.sender.id, request);
    },
  );
}

export function disposeThreadHandoffIpc(): void {
  ipcMain.removeHandler(FEDERATION_HANDOFF_THREAD_CHANNEL);
  ipcMain.removeHandler(FEDERATION_CANCEL_HANDOFF_THREAD_CHANNEL);
  ipcMain.removeHandler(FEDERATION_RETRY_HANDOFF_THREAD_NOW_CHANNEL);
  controller?.dispose();
  controller = undefined;
}
