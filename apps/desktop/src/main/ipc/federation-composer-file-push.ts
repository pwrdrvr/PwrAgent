import { ipcMain } from "electron";
import path from "node:path";
import type {
  CancelComposerFilePushRequest,
  ComposerFilePushProgress,
  PushComposerFileRequest,
  PushComposerFileResult,
} from "@pwragent/shared";
import { isFederationInstanceId } from "@pwragent/shared";
import {
  FEDERATION_CANCEL_COMPOSER_FILE_PUSH_CHANNEL,
  FEDERATION_COMPOSER_FILE_PUSH_PROGRESS_CHANNEL,
  FEDERATION_PUSH_COMPOSER_FILE_CHANNEL,
} from "../../shared/ipc";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import type { PushFederationFileOptions } from "../federation/federation-file-push";

/** One progress event per chunk would be ~4 per MiB; a frame or two is plenty. */
const PROGRESS_INTERVAL_MS = 150;
const MAX_UPLOAD_ID_LENGTH = 128;

type PushFile = (
  request: PushComposerFileRequest,
  options: PushFederationFileOptions,
) => Promise<PushComposerFileResult>;

type Sender = {
  id: number;
  isDestroyed: () => boolean;
  send: (channel: string, progress: ComposerFilePushProgress) => void;
  once: (event: "destroyed", listener: () => void) => void;
};

/**
 * Viewer-side composer uploads to a remote thread's owner. Each upload is
 * owned by the window that started it: that window alone gets its progress,
 * can cancel it, and closing it cancels whatever it still has in flight.
 */
export function createComposerFilePushController(options: {
  push: PushFile;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const uploads = new Map<string, { controller: AbortController; senderId: number }>();
  const watchedSenders = new Set<number>();

  const cancelSender = (senderId: number): void => {
    watchedSenders.delete(senderId);
    for (const upload of uploads.values()) {
      if (upload.senderId === senderId) upload.controller.abort();
    }
  };

  return {
    async push(sender: Sender, request: PushComposerFileRequest): Promise<PushComposerFileResult> {
      if (
        !request
        || typeof request.uploadId !== "string"
        || !request.uploadId
        || request.uploadId.length > MAX_UPLOAD_ID_LENGTH
        || request.target?.scope !== "remote"
        || !isFederationInstanceId(request.target.instanceId)
        || typeof request.sourcePath !== "string"
        || !path.isAbsolute(request.sourcePath)
      ) {
        throw new Error("Invalid file upload request.");
      }
      const key = `${sender.id}:${request.uploadId}`;
      if (uploads.has(key)) throw new Error("This file upload is already running.");
      if (!watchedSenders.has(sender.id)) {
        watchedSenders.add(sender.id);
        const senderId = sender.id;
        sender.once("destroyed", () => cancelSender(senderId));
      }
      const controller = new AbortController();
      uploads.set(key, { controller, senderId: sender.id });
      let lastSentAt = Number.NEGATIVE_INFINITY;
      const report = (sentBytes: number, totalBytes: number): void => {
        const at = now();
        // Always report the first and last update; throttle the rest.
        if (sentBytes !== 0 && sentBytes !== totalBytes && at - lastSentAt < PROGRESS_INTERVAL_MS) return;
        lastSentAt = at;
        if (sender.isDestroyed()) return;
        sender.send(FEDERATION_COMPOSER_FILE_PUSH_PROGRESS_CHANNEL, {
          uploadId: request.uploadId,
          sentBytes,
          totalBytes,
        });
      };
      try {
        return await options.push(
          { uploadId: request.uploadId, target: request.target, sourcePath: request.sourcePath },
          { signal: controller.signal, onProgress: report },
        );
      } finally {
        uploads.delete(key);
      }
    },
    cancel(senderId: number, request: CancelComposerFilePushRequest): void {
      if (typeof request?.uploadId !== "string") return;
      uploads.get(`${senderId}:${request.uploadId}`)?.controller.abort();
    },
    dispose(): void {
      for (const upload of uploads.values()) upload.controller.abort();
      uploads.clear();
      watchedSenders.clear();
    },
  };
}

let controller: ReturnType<typeof createComposerFilePushController> | undefined;

export function registerComposerFilePushIpc(): void {
  disposeComposerFilePushIpc();
  const active = createComposerFilePushController({
    push: async (request, pushOptions) =>
      await getDesktopFederationRuntime().pushFile(
        request.target,
        request.sourcePath,
        undefined,
        pushOptions,
      ),
  });
  controller = active;
  ipcMain.handle(
    FEDERATION_PUSH_COMPOSER_FILE_CHANNEL,
    async (event, request: PushComposerFileRequest): Promise<PushComposerFileResult> =>
      await active.push(event.sender, request),
  );
  ipcMain.handle(
    FEDERATION_CANCEL_COMPOSER_FILE_PUSH_CHANNEL,
    (event, request: CancelComposerFilePushRequest): void => {
      active.cancel(event.sender.id, request);
    },
  );
}

export function disposeComposerFilePushIpc(): void {
  ipcMain.removeHandler(FEDERATION_PUSH_COMPOSER_FILE_CHANNEL);
  ipcMain.removeHandler(FEDERATION_CANCEL_COMPOSER_FILE_PUSH_CHANNEL);
  controller?.dispose();
  controller = undefined;
}
