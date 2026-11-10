import type { StorageMaintenanceCommand, StorageMaintenanceStatus } from "../shared/storage-maintenance";

export interface StorageMaintenanceView {
  loaded: Promise<void>;
  isClosed(): boolean;
  isLoading(): boolean | undefined;
  describeLoad(): Record<string, unknown>;
  publish(status: StorageMaintenanceStatus): void;
  hold(): void;
  show(): void;
  close(): void;
  onCommand(handler: (command: StorageMaintenanceCommand) => Promise<StorageMaintenanceStatus>): void;
  onClosed(handler: () => void): void;
  onQuit(handler: () => void): () => void;
}

export interface StorageMaintenanceWorker {
  postMessage(message: unknown): void;
  on(event: "message", listener: (status: Partial<StorageMaintenanceStatus>) => void): unknown;
  once(event: "exit", listener: (code: number) => void): unknown;
  kill(): boolean;
}

export interface StorageMaintenanceHost {
  /** A manual cleanup prompt requires an interactive desktop host. */
  interactive?: boolean;
  createView(): StorageMaintenanceView;
  forkWorker(path: string): StorageMaintenanceWorker;
}
