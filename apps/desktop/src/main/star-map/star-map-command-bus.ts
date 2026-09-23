import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type {
  PwrAgentStarMapResponse,
  StarMapCommand,
  StarMapCommandResult,
} from "@pwragent/shared";
import { STAR_MAP_COMMAND_CHANNEL } from "../../shared/ipc";
import { currentStarMapWebContents } from "./star-map-view-registry";

/**
 * Longer than the renderer's own wait for a thread it has to load before it
 * can fly there, so the map's answer - including "could not load it" - is
 * what the Agent hears, rather than this timeout.
 */
export const STAR_MAP_COMMAND_TIMEOUT_MS = 15_000;

type FlightResponse = PwrAgentStarMapResponse<"fly_star_map_to">;

type Pending = {
  webContentsId: number;
  settle: (response: FlightResponse) => void;
};

const pending = new Map<string, Pending>();

export type StarMapCommandDeps = {
  webContents?: () => WebContents | undefined;
  timeoutMs?: number;
  newRequestId?: () => string;
};

/**
 * Send a command to the map the Agent last read, and wait for its answer.
 *
 * Resolves `undefined` when no map is open. Every other outcome - the map's
 * answer, the map closing mid-command, or no answer at all - resolves to a
 * tool response, so a turn is never left waiting on a window.
 */
export async function sendStarMapCommand(
  command: Omit<StarMapCommand, "requestId">,
  deps: StarMapCommandDeps = {},
): Promise<FlightResponse | undefined> {
  const webContents = (deps.webContents ?? currentStarMapWebContents)();
  if (!webContents || webContents.isDestroyed()) return undefined;
  const requestId = (deps.newRequestId ?? randomUUID)();
  const timeoutMs = deps.timeoutMs ?? STAR_MAP_COMMAND_TIMEOUT_MS;
  return await new Promise<FlightResponse>((resolve) => {
    const settle = (response: FlightResponse): void => {
      if (pending.get(requestId)?.settle !== settle) return;
      pending.delete(requestId);
      clearTimeout(timer);
      webContents.removeListener("destroyed", onDestroyed);
      resolve(response);
    };
    const onDestroyed = (): void => {
      settle({
        ok: false,
        error: {
          code: "star_map_not_open",
          message: "The Star Map closed before it answered.",
        },
      });
    };
    const timer = setTimeout(() => {
      settle({
        ok: false,
        error: {
          code: "internal_error",
          message: `The Star Map did not answer within ${Math.round(timeoutMs / 1000)} seconds.`,
        },
      });
    }, timeoutMs);
    pending.set(requestId, { webContentsId: webContents.id, settle });
    webContents.once("destroyed", onDestroyed);
    webContents.send(STAR_MAP_COMMAND_CHANNEL, { ...command, requestId });
  });
}

/**
 * Deliver a map's answer. Only the renderer the command went to may answer
 * it: any other window answering would be reporting on a map it is not.
 */
export function resolveStarMapCommand(params: {
  senderId: number;
  result: StarMapCommandResult;
}): boolean {
  const entry = pending.get(params.result.requestId);
  if (!entry || entry.webContentsId !== params.senderId) return false;
  entry.settle(params.result.response);
  return true;
}

/** Test seam: forget every command still waiting for an answer. */
export function resetStarMapCommandBus(): void {
  pending.clear();
}
