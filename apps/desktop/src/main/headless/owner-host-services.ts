import { createOutpostRuntimePolicy, type OwnerRuntimePolicy } from "../owner-runtime-policy";
import os from "node:os";
import path from "node:path";
import { mkdir, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { OwnerHostServices } from "../owner-host";
import type { NodeRuntimeMetadata } from "../runtime-resources";
import { forkOwnerWorker } from "../node-worker-process";
import { createFileKeyEncryption } from "./file-key-encryption";
import { createHeadlessImage } from "./image";

export function createHeadlessOwnerHostServices(options: {
  runtime: NodeRuntimeMetadata;
  profileDirectory: string;
  onQuit(): void;
  runtimePolicy?: OwnerRuntimePolicy;
}): OwnerHostServices {
  const unavailable = (): never => { throw new Error("This operation requires the desktop host."); };
  const runtimePolicy = options.runtimePolicy ?? createOutpostRuntimePolicy();
  return {
    runtimePolicy,
    application: {
      getVersion: () => options.runtime.version,
      isPackaged: options.runtime.isPackaged,
      getPath: () => path.join(os.homedir(), "Downloads"),
      relaunch: unavailable, quit: () => options.onQuit(),
    },
    secrets: createFileKeyEncryption(path.join(options.profileDirectory, "state")),
    images: { createFromBuffer: createHeadlessImage },
    links: {
      openExternal: async () => unavailable(),
      openPath: async () => "Opening files in an application requires the desktop host.",
      showItemInFolder: () => {},
      trashItem: async (file) => {
        const trash = path.join(options.profileDirectory, "trash");
        await mkdir(trash, { recursive: true, mode: 0o700 });
        await rename(file, path.join(trash, `${randomUUID()}-${path.basename(file)}`));
      },
    },
    renderer: { subscribers: () => [], agentEvent: () => {}, environmentSetupProgress: () => {}, inboundPreview: () => {}, managedRuntimeProgress: () => {}, managedGrokSignatureRejected: () => {} },
    threads: { showThread: () => {}, openMaintenance: () => false, openThread: async () => unavailable() },
    appearance: { broadcast: () => {}, syncDock: () => {} },
    notifications: { notifyAttention: () => {}, notifyTerminal: () => {}, notifyApproval: () => {}, clearAttentionKey: () => {} },
    ui: { isWindowVisible: () => false, pickFiles: async () => ({ canceled: true, filePaths: [] }), explainLocalNetwork: async () => {} },
    starMap: { sendCommand: async () => undefined, readView: () => undefined, readFocus: () => undefined },
    updates: { check: async () => unavailable(), read: unavailable, install: async () => unavailable(), requestQuit: async () => unavailable() },
    workers: { forkClaudeSessionReader: async (file, env) => forkOwnerWorker(file, env) },
    storageMaintenance: {
      interactive: false,
      forkWorker: (file) => forkOwnerWorker(file),
      createView: () => ({
        loaded: Promise.resolve(), isClosed: () => false, isLoading: () => false, describeLoad: () => ({ host: "headless" }),
        publish: () => {}, hold: () => {}, show: () => {}, close: () => {}, onCommand: () => {}, onClosed: () => {}, onQuit: (handler) => {
          process.on("SIGINT", handler);
          process.on("SIGTERM", handler);
          return () => { process.off("SIGINT", handler); process.off("SIGTERM", handler); };
        },
      }),
    },
    replayClients: () => undefined,
  };
}
