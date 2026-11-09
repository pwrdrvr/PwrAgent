import type {
  SetDirectoryPinRequest,
  SetDirectoryPinResponse,
  ReorderDirectoryPinsRequest,
  ReorderDirectoryPinsResponse,
} from "@pwragent/shared";
import { getDesktopBackendRegistry } from "./backend-registry";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";
import { getMainLogger } from "../log";

function logDebug(event: string, payload: Record<string, unknown>): void {
  if (process.env.NODE_ENV !== "production") getMainLogger("pwragent:app-server").debug(event, payload);
}

/**
 * Reject directory preference writes that target the synthetic
 * catch-all bucket (`unlinked`). Both real directories
 * (`directory:*`) and workspaces (`workspace:*`) are named entries
 * the user actually browses. The `unlinked` bucket is a roll-up of
 * threads with no linked directory and doesn't model a single
 * entry, so sticky preferences there are meaningless.
 */
export function rejectNonUserDirectoryKey(directoryKey: string): void {
  if (
    !directoryKey.startsWith("directory:") &&
    !directoryKey.startsWith("workspace:")
  ) {
    throw new Error(
      `Cannot persist preferences for synthetic directory entry: ${directoryKey} (only directory:* and workspace:* keys are supported)`,
    );
  }
}

/** The same owner write and event path serves local windows and remote viewers. */
export async function setLocalDirectoryPin(
  request: Omit<SetDirectoryPinRequest, "federationTarget">,
): Promise<SetDirectoryPinResponse> {
  rejectNonUserDirectoryKey(request.directoryKey);

  const overlay = await getDesktopOverlayStore().setDirectoryPin({
    directoryKey: request.directoryKey,
    pinned: request.pinned,
    pinnedRank: request.pinnedRank,
  });

  logDebug("setDirectoryPin", {
    directoryKey: request.directoryKey,
    pinnedRank: overlay.pinnedRank ?? null,
  });

  await getDesktopBackendRegistry().publishLocalEvent({
    backend: "codex",
    notification: overlay.pinnedRank
      ? {
          method: "directory/pin/added",
          params: {
            directoryKey: request.directoryKey,
            pinnedRank: overlay.pinnedRank,
          },
        }
      : {
          method: "directory/pin/removed",
          params: {
            directoryKey: request.directoryKey,
          },
        },
  });

  return {
    directoryKey: request.directoryKey,
    pinnedRank: overlay.pinnedRank,
  };
}

export async function reorderLocalDirectoryPins(
  request: Omit<ReorderDirectoryPinsRequest, "federationTarget">,
): Promise<ReorderDirectoryPinsResponse> {
  for (const directoryKey of request.directoryKeys ?? [request.move?.key, request.move?.anchorKey].filter((key): key is string => Boolean(key))) {
    rejectNonUserDirectoryKey(directoryKey);
  }

  const pinnedRanks = await getDesktopOverlayStore().reorderDirectoryPins({
    directoryKeys: request.directoryKeys,
    ...(request.move ? { move: request.move } : {}),
  });

  logDebug("reorderDirectoryPins", {
    pinCount: request.directoryKeys?.length ?? 1,
  });

  await getDesktopBackendRegistry().publishLocalEvent({
    backend: "codex",
    notification: {
      method: "directory/pin/reordered",
      params: {
        pinnedRanks,
      },
    },
  });

  return { pinnedRanks };
}

