import { ipcMain } from "electron";
import type {
  FederationTarget,
  ReadStarMapArrangementResponse,
  SetStarMapCardPositionRequest,
  StarMapArrangementEntry,
  StarMapIntakeRequest,
  StarMapIntakeResponse,
} from "@pwragent/shared";
import {
  isRemoteFederationTarget,
  isStarMapArrangementEntry,
} from "@pwragent/shared";
import {
  STAR_MAP_INTAKE_CHANNEL,
  STAR_MAP_READ_ARRANGEMENT_CHANNEL,
  STAR_MAP_SET_CARD_POSITION_CHANNEL,
} from "../../shared/ipc";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { dispatchStarMapIntake } from "../app-server/star-map-intake";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";

export function registerStarMapIpcHandlers(): void {
  ipcMain.removeHandler(STAR_MAP_READ_ARRANGEMENT_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_SET_CARD_POSITION_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_INTAKE_CHANNEL);
  ipcMain.handle(
    STAR_MAP_INTAKE_CHANNEL,
    async (
      _event,
      request: StarMapIntakeRequest & { federationTarget?: FederationTarget },
    ): Promise<StarMapIntakeResponse> => {
      const { federationTarget, ...intake } = request;
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
}

export function disposeStarMapIpcHandlers(): void {
  ipcMain.removeHandler(STAR_MAP_READ_ARRANGEMENT_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_SET_CARD_POSITION_CHANNEL);
  ipcMain.removeHandler(STAR_MAP_INTAKE_CHANNEL);
}
