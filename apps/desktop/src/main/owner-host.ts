import type { ManagedRuntimeProgress } from "../shared/managed-runtime-progress";
import type { ManagedGrokSignatureRejectedEvent } from "../shared/managed-grok-signature";
import type { StorageMaintenanceHost } from "./storage-maintenance-host";
import type { BootstrapAppearance } from "./settings/appearance-bootstrap";
import type { SettingsSecretEncryption } from "@pwragent/owner-core/settings-secret-storage";
import type { MessagingApprovalDecision, MessagingApprovalIntent } from "@pwragent/messaging-interface";
import type { AgentEvent, InboundPreviewMessage, CodexEnvironmentSetupProgressEvent, OpenThreadToolArgs, PwrAgentStarMapResponse, OperatorFocusSnapshot, StarMapCommandInput, StarMapCommandResponse, StarMapViewSnapshot } from "@pwragent/shared";
import type { WindowShowThreadRequest } from "../shared/window-show-thread";
import type { AppUpdateCheckResult, AppUpdateInstallResult, AppUpdateStatus } from "../shared/app-metadata";
import type { ClaudeSessionReaderChild } from "./claude/claude-session-reader-contracts";
import type { OwnerReplayClients } from "./testing/replay-clients";

/** Host capabilities used by owners. None of these contracts requires a window. */
export interface RendererEventTarget {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export interface RendererEventSink {
  /** Preserve subscriber order and synchronous delivery, including thrown errors. */
  subscribers(channel: string): RendererEventTarget[];
  agentEvent(event: AgentEvent): void;
  environmentSetupProgress(event: CodexEnvironmentSetupProgressEvent): void;
  inboundPreview(message: InboundPreviewMessage): void;
  managedRuntimeProgress(event: ManagedRuntimeProgress): void;
  managedGrokSignatureRejected(event: ManagedGrokSignatureRejectedEvent): void;
}

export interface HostImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(options: { width?: number; height?: number; quality?: "best" | "good" | "better" }): HostImage;
  toPNG(): Buffer;
  toJPEG(quality: number): Buffer;
  toDataURL(): string;
}

export interface ThreadPresenter {
  showThread(request: WindowShowThreadRequest): void;
  openMaintenance(request?: { projectKey?: string }): boolean;
  openThread(args: OpenThreadToolArgs): Promise<PwrAgentStarMapResponse<"open_thread">>;
}

type NotificationText = { enabled: boolean; title: string; body: string; onShow?: () => void };
export interface OwnerNotifications {
  notifyAttention(params: NotificationText & { key: string }): void;
  notifyTerminal(params: NotificationText & { key?: string }): void;
  notifyApproval(params: { enabled: boolean; key: string; intent: MessagingApprovalIntent; onDecision?: (decision: MessagingApprovalDecision) => void; onShow?: () => void }): void;
  clearAttentionKey(key: string): void;
}

export interface FilePickerOptions {
  title: string;
  buttonLabel?: string;
  defaultPath?: string;
  properties: Array<"openDirectory" | "createDirectory" | "openFile" | "multiSelections">;
}

export interface OwnerHostServices {
  application: { getVersion(): string; isPackaged: boolean; getPath(name: "downloads"): string; relaunch(): void; quit(): void };
  secrets: SettingsSecretEncryption<Buffer>;
  links: { openExternal(url: string): Promise<void>; openPath(path: string): Promise<string>; showItemInFolder(path: string): void; trashItem(path: string): Promise<void> };
  images: { createFromBuffer(buffer: Buffer): HostImage };
  renderer: RendererEventSink;
  appearance: { broadcast(value: BootstrapAppearance): void; syncDock(value: Pick<BootstrapAppearance, "theme" | "darkTheme" | "lightTheme"> & { themedDockIcon: boolean }): void };
  threads: ThreadPresenter;
  notifications: OwnerNotifications;
  ui: {
    isWindowVisible(): boolean;
    pickFiles(options: FilePickerOptions, parent?: unknown): Promise<{ canceled: boolean; filePaths: string[] }>;
    explainLocalNetwork(hostname: string): Promise<void>;
  };
  starMap: {
    sendCommand(command: StarMapCommandInput): Promise<StarMapCommandResponse | undefined>;
    readView(): StarMapViewSnapshot | undefined;
    readFocus(): { focus: OperatorFocusSnapshot; receivedAt: number } | undefined;
  };
  updates: {
    check(source: "manual"): Promise<AppUpdateCheckResult>;
    read(): AppUpdateStatus;
    install(options: { requestQuit: (performQuit: () => void, beforeQuit?: () => boolean) => Promise<boolean> }): Promise<AppUpdateInstallResult>;
    requestQuit(options: { performQuit: () => void; source: "agent-tool" | "update-install"; beforeQuit?: () => boolean }): Promise<boolean>;
  };
  workers: { forkClaudeSessionReader(path: string, env: NodeJS.ProcessEnv): Promise<ClaudeSessionReaderChild> };
  storageMaintenance: StorageMaintenanceHost;
  replayClients(): OwnerReplayClients | undefined;
}

let host: OwnerHostServices | undefined;

export function installOwnerHostServices(services: OwnerHostServices): void {
  host = services;
}

export function getOwnerHostServices(): OwnerHostServices {
  if (!host) throw new Error("Owner host services are unavailable before startOwnerServices().");
  return host;
}

export const applicationHost: OwnerHostServices["application"] = {
  getVersion: () => getOwnerHostServices().application.getVersion(),
  get isPackaged() { return getOwnerHostServices().application.isPackaged; },
  getPath: (name) => getOwnerHostServices().application.getPath(name),
  relaunch: () => getOwnerHostServices().application.relaunch(),
  quit: () => getOwnerHostServices().application.quit(),
};

export const secretEncryption: SettingsSecretEncryption<Buffer> = {
  isEncryptionAvailable: () => getOwnerHostServices().secrets.isEncryptionAvailable(),
  encryptString: (value) => getOwnerHostServices().secrets.encryptString(value),
  decryptString: (value) => getOwnerHostServices().secrets.decryptString(value),
  getSelectedStorageBackend: () => getOwnerHostServices().secrets.getSelectedStorageBackend?.() ?? "unavailable",
  getCiphertextAccessError: (value) => getOwnerHostServices().secrets.getCiphertextAccessError?.(value),
};

export const externalLinks: OwnerHostServices["links"] = {
  openExternal: (url) => getOwnerHostServices().links.openExternal(url),
  openPath: (path) => getOwnerHostServices().links.openPath(path),
  showItemInFolder: (path) => getOwnerHostServices().links.showItemInFolder(path),
  trashItem: (path) => getOwnerHostServices().links.trashItem(path),
};

export const imageCodec: OwnerHostServices["images"] = {
  createFromBuffer: (buffer) => getOwnerHostServices().images.createFromBuffer(buffer),
};

export const rendererSubscribers = (channel: string): RendererEventTarget[] => getOwnerHostServices().renderer.subscribers(channel);
export const requestShowThread = (request: WindowShowThreadRequest): void => getOwnerHostServices().threads.showThread(request);
export const ownerNotifications = (): OwnerNotifications => getOwnerHostServices().notifications;
