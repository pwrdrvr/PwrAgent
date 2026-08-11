import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { JsonRpcObserver } from "@pwrdrvr/agent-transport";
import type {
  CodexProtocolCaptureResult,
  CodexProtocolCaptureStatus,
} from "../../shared/codex-protocol-capture";
import { getMainLogger } from "../log";
import { resolveActiveProfilePath } from "../profile";
import { ProtocolCaptureStore } from "../testing/capture-store";
import {
  buildProtocolCaptureId,
  createProtocolCaptureObserver,
} from "../testing/protocol-capture";

const protocolCaptureLog = getMainLogger("pwragent:protocol-capture");

type ActiveCapture = {
  observer: JsonRpcObserver;
  startedAt: number;
  store: ProtocolCaptureStore;
};

export class CodexProtocolCaptureSession {
  private activeCapture?: ActiveCapture;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly createCaptureId: (startedAt: number) => string;
  private readonly resolveRootDir: () => string;

  readonly observer: JsonRpcObserver = {
    onMessage: async (event) => {
      const capture = this.activeCapture;
      if (!capture) {
        return;
      }
      await capture.observer.onMessage(event);
    },
  };

  constructor(options: {
    createCaptureId?: (startedAt: number) => string;
    now?: () => number;
    rootDir?: string;
  } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createCaptureId =
      options.createCaptureId ??
      ((startedAt) =>
        [
          buildProtocolCaptureId("codex", "default", startedAt),
          randomUUID().slice(0, 8),
        ].join("-"));
    const rootDir = options.rootDir;
    this.resolveRootDir = rootDir
      ? () => rootDir
      : () => resolveActiveProfilePath("state/protocol-captures");
  }

  getStatus(): CodexProtocolCaptureStatus {
    const capture = this.activeCapture;
    if (!capture) {
      return { active: false, available: true };
    }
    return {
      active: true,
      available: true,
      captureFilePath: capture.store.captureFilePath,
      startedAt: new Date(capture.startedAt).toISOString(),
    };
  }

  async start(): Promise<CodexProtocolCaptureStatus> {
    return await this.mutate(async () => {
      if (this.activeCapture) {
        return this.getStatus();
      }

      const startedAt = this.now();
      const store = new ProtocolCaptureStore({
        backend: "codex",
        backendInstance: "default",
        captureId: this.createCaptureId(startedAt),
        rootDir: this.resolveRootDir(),
      });
      await store.open();
      this.activeCapture = {
        observer: createProtocolCaptureObserver({
          backend: "codex",
          store,
        }),
        startedAt,
        store,
      };
      protocolCaptureLog.info("diagnostic capture started", {
        path: store.captureFilePath,
      });
      return this.getStatus();
    });
  }

  async stop(): Promise<CodexProtocolCaptureResult | undefined> {
    return await this.mutate(async () => {
      const capture = this.activeCapture;
      if (!capture) {
        return undefined;
      }

      this.activeCapture = undefined;
      const finalizationErrors: string[] = [];
      try {
        await capture.store.close();
      } catch (error) {
        finalizationErrors.push(
          `Capture writes did not finish: ${errorMessage(error)}`,
        );
      }
      let sizeBytes: number | undefined;
      try {
        sizeBytes = (await fs.stat(capture.store.captureFilePath)).size;
      } catch (error) {
        finalizationErrors.push(
          `Capture size could not be read: ${errorMessage(error)}`,
        );
      }
      const result: CodexProtocolCaptureResult = {
        captureFilePath: capture.store.captureFilePath,
        ...(finalizationErrors.length > 0
          ? { finalizationError: finalizationErrors.join(" ") }
          : {}),
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        startedAt: new Date(capture.startedAt).toISOString(),
        stoppedAt: new Date(this.now()).toISOString(),
      };
      if (result.finalizationError) {
        protocolCaptureLog.warn("diagnostic capture stopped with warning", {
          error: result.finalizationError,
          path: result.captureFilePath,
          sizeBytes: result.sizeBytes,
        });
      } else {
        protocolCaptureLog.info("diagnostic capture stopped", {
          path: result.captureFilePath,
          sizeBytes: result.sizeBytes,
        });
      }
      return result;
    });
  }

  async close(): Promise<void> {
    await this.stop();
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return await result;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
