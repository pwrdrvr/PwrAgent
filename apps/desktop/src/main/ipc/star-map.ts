import { BrowserWindow, ipcMain, type WebContents } from "electron";
import type {
  OpenStarMapManagerRequest,
  OpenStarMapManagerResponse,
  ReadStarMapArrangementResponse,
  ReadStarMapWorkspaceResponse,
  SetStarMapCardPositionRequest,
  StarMapArrangementEntry,
  StarMapIntakeRequest,
  StarMapIntakeResponse,
  StarMapViewSnapshot,
  WriteStarMapWorkspaceRequest,
} from "@pwragent/shared";
import {
  MAX_STAR_MAP_INTAKE_IMAGE_UPLOADS,
  type StarMapIntakeDispatchRequest,
} from "../../shared/star-map-intake";
import {
  isRemoteFederationTarget,
  isStarMapArrangementEntry,
  isStarMapViewSnapshot,
  isStarMapWorkspaceSnapshot,
} from "@pwragent/shared";
import {
  STAR_MAP_FOCUS_MAIN_WINDOW_CHANNEL,
  STAR_MAP_INTAKE_CHANNEL,
  STAR_MAP_OPEN_THREAD_IN_MAIN_CHANNEL,
  STAR_MAP_OPEN_MANAGER_CHANNEL,
  STAR_MAP_OPEN_WINDOW_CHANNEL,
  STAR_MAP_PUBLISH_VIEW_CHANNEL,
  STAR_MAP_READ_ARRANGEMENT_CHANNEL,
  STAR_MAP_READ_WORKSPACE_CHANNEL,
  STAR_MAP_SET_CARD_POSITION_CHANNEL,
  STAR_MAP_WRITE_WORKSPACE_CHANNEL,
  WINDOW_SHOW_THREAD_CHANNEL,
} from "../../shared/ipc";
import type { WindowShowThreadRequest } from "../../shared/window-show-thread";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { dispatchStarMapIntake } from "../app-server/star-map-intake";
import {
  MAX_TURN_INPUT_ATTACHMENT_BYTES,
  stageTurnInputAttachments,
  type TurnInputAttachmentUpload,
} from "../app-server/turn-input-attachment-files";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { isFederationWindowWebContents } from "../window";
import { subscribersForChannel } from "../window-channels";
import { requestShowThread } from "../window-show-thread";
import {
  isStarMapWindowWebContents,
  showStarMapWindow,
} from "../star-map-window";
import { publishStarMapView } from "../star-map/star-map-view-registry";
import { openStarMapManagerThread } from "../star-map/star-map-manager-thread";

/**
 * The main window the Star Map window's cross-window actions target.
 * Federation remote-viewer windows subscribe to the same channel but
 * front another instance's threads, so they are never a valid target
 * for a local thread.
 */
function primaryMainWindowWebContents(): WebContents | undefined {
  return subscribersForChannel(WINDOW_SHOW_THREAD_CHANNEL).find(
    (subscriber) => !isFederationWindowWebContents(subscriber),
  );
}

function normalizeStarMapIntakeImageUploads(
  value: unknown,
): TurnInputAttachmentUpload[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Invalid Star Map image uploads");
  }
  if (value.length > MAX_STAR_MAP_INTAKE_IMAGE_UPLOADS) {
    throw new Error(
      `Star Map intake accepts at most ${MAX_STAR_MAP_INTAKE_IMAGE_UPLOADS} images.`,
    );
  }
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Invalid Star Map image upload");
    }
    const upload = candidate as {
      bytes?: unknown;
      mimeType?: unknown;
      name?: unknown;
    };
    if (
      !(upload.bytes instanceof Uint8Array)
      || upload.bytes.byteLength === 0
      || upload.bytes.byteLength > MAX_TURN_INPUT_ATTACHMENT_BYTES
      || typeof upload.mimeType !== "string"
      || !/^image\/[a-z0-9.+-]+$/iu.test(upload.mimeType)
      || upload.mimeType.length > 100
      || typeof upload.name !== "string"
      || upload.name.trim().length === 0
      || upload.name.length > 200
    ) {
      throw new Error("Invalid Star Map image upload");
    }
    return {
      type: "localImage" as const,
      data: upload.bytes,
      mimeType: upload.mimeType,
      name: upload.name.trim(),
    };
  });
}

async function stageStarMapIntakeRequest(
  request: StarMapIntakeDispatchRequest,
): Promise<StarMapIntakeRequest> {
  const uploads = normalizeStarMapIntakeImageUploads(request.imageUploads);
  const attachments = uploads.length > 0
    ? await stageTurnInputAttachments(uploads)
    : [];
  return {
    requestId: request.requestId,
    request: request.request,
    ...(request.directoryKey !== undefined
      ? { directoryKey: request.directoryKey }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function registerStarMapIpcHandlers(): void {
  ipcMain.removeHandler(STAR_MAP_READ_ARRANGEMENT_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_READ_WORKSPACE_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_SET_CARD_POSITION_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_WRITE_WORKSPACE_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_INTAKE_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_OPEN_WINDOW_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_OPEN_THREAD_IN_MAIN_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_FOCUS_MAIN_WINDOW_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_PUBLISH_VIEW_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_OPEN_MANAGER_CHANNEL);
  ipcMain.handle(STAR_MAP_OPEN_WINDOW_CHANNEL, async (event): Promise<void> => {
    showStarMapWindow({
      sourceWindow: BrowserWindow.fromWebContents(event.sender),
    });
  });
  ipcMain.handle(
    STAR_MAP_OPEN_THREAD_IN_MAIN_CHANNEL,
    async (_event, request: WindowShowThreadRequest): Promise<void> => {
      if (
        typeof request?.backend !== "string"
        || typeof request?.threadId !== "string"
      ) {
        return;
      }
      const target = primaryMainWindowWebContents();
      if (!target) {
        return;
      }
      requestShowThread(request, { preferWebContents: target });
    },
  );
  ipcMain.handle(STAR_MAP_FOCUS_MAIN_WINDOW_CHANNEL, async (): Promise<void> => {
    const target = primaryMainWindowWebContents();
    const window = target ? BrowserWindow.fromWebContents(target) : undefined;
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.show();
    window.focus();
  });
  ipcMain.handle(
    STAR_MAP_INTAKE_CHANNEL,
    async (
      _event,
      request: StarMapIntakeDispatchRequest,
    ): Promise<StarMapIntakeResponse> => {
      const intake = await stageStarMapIntakeRequest(request);
      const { federationTarget } = request;
      if (federationTarget && isRemoteFederationTarget(federationTarget)) {
        // Execute on the owning instance: its directory registry, defaults,
        // and AGENTS.md preferences are the ones the intake must consult.
        return await getDesktopFederationRuntime()
          .remoteBackend(federationTarget)
          .starMapIntake(intake);
      }
      return await dispatchStarMapIntake(intake);
    },
  );
  ipcMain.handle(
    STAR_MAP_OPEN_MANAGER_CHANNEL,
    async (
      _event,
      request: OpenStarMapManagerRequest,
    ): Promise<OpenStarMapManagerResponse> =>
      // Local only: the manager reads the viewer's own map, and its tools
      // already reach peers by instanceId when a request needs them to.
      await openStarMapManagerThread(request ?? {}),
  );
  ipcMain.handle(
    STAR_MAP_PUBLISH_VIEW_CHANNEL,
    async (event, snapshot: StarMapViewSnapshot): Promise<void> => {
      // The sender is checked, not just the payload. The preload is shared
      // by every window, so without this a Settings or Activity renderer
      // could publish a fabricated map that `read_star_map_view` then
      // reports to a model as the operator's screen.
      if (!isStarMapWindowWebContents(event.sender)) {
        return;
      }
      // Validated rather than trusted: this lands in an Agent tool result,
      // and a malformed snapshot would be reported to the model as the
      // operator's screen.
      if (!isStarMapViewSnapshot(snapshot)) {
        return;
      }
      publishStarMapView({ snapshot, webContents: event.sender });
    },
  );
  ipcMain.handle(
    STAR_MAP_READ_ARRANGEMENT_CHANNEL,
    async (): Promise<ReadStarMapArrangementResponse> => ({
      entries: await getDesktopOverlayStore().readStarMapArrangement(),
    }),
  );
  ipcMain.handle(
    STAR_MAP_SET_CARD_POSITION_CHANNEL,
    async (
      _event,
      request: SetStarMapCardPositionRequest,
    ): Promise<ReadStarMapArrangementResponse> => {
      const runtime = getDesktopFederationRuntime();
      const entry: StarMapArrangementEntry = {
        instanceId: request.instanceId,
        threadKey: request.threadKey,
        dx: request.dx,
        dy: request.dy,
        updatedAt: Date.now(),
        by: runtime.localFederationInstanceId(),
      };
      if (!isStarMapArrangementEntry(entry)) {
        throw new Error("Invalid star map card position");
      }
      const { accepted } = await getDesktopOverlayStore()
        .mergeStarMapArrangement([entry]);
      if (accepted.length > 0) {
        // Local windows re-render on the agent event; connected peers get
        // the delta and the gateway relays it to every sibling.
        runtime.publishStarMapArrangementChanged(accepted);
        runtime.broadcastStarMapArrangement(accepted);
      }
      return {
        entries: await getDesktopOverlayStore().readStarMapArrangement(),
      };
    },
  );
  ipcMain.handle(
    STAR_MAP_READ_WORKSPACE_CHANNEL,
    async (): Promise<ReadStarMapWorkspaceResponse> => ({
      workspace: await getDesktopOverlayStore().readStarMapWorkspace(),
    }),
  );
  ipcMain.handle(
    STAR_MAP_WRITE_WORKSPACE_CHANNEL,
    async (
      _event,
      request: WriteStarMapWorkspaceRequest,
    ): Promise<ReadStarMapWorkspaceResponse> => {
      if (!isStarMapWorkspaceSnapshot(request?.workspace)) {
        throw new Error("Invalid Star Map workspace");
      }
      if (
        typeof request.baseRevision !== "number"
        || !Number.isSafeInteger(request.baseRevision)
        || request.baseRevision < 0
      ) {
        throw new Error("Invalid Star Map workspace base revision");
      }
      return {
        workspace: await getDesktopOverlayStore()
          .writeStarMapWorkspace(request.workspace, request.baseRevision),
      };
    },
  );
}

export function disposeStarMapIpcHandlers(): void {
  ipcMain.removeHandler(STAR_MAP_OPEN_MANAGER_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_PUBLISH_VIEW_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_READ_ARRANGEMENT_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_READ_WORKSPACE_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_SET_CARD_POSITION_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_WRITE_WORKSPACE_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_INTAKE_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_OPEN_WINDOW_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_OPEN_THREAD_IN_MAIN_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_FOCUS_MAIN_WINDOW_CHANNEL);
}
