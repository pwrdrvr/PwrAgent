import type {
  ReadDesktopSettingsResponse,
} from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";

export const RENDERER_SETTINGS_READ_REUSE_TTL_MS = 5_000;

type SettingsReadEntry = {
  completedAt?: number;
  promise: Promise<ReadDesktopSettingsResponse>;
};

const readsByApi = new WeakMap<object, SettingsReadEntry>();

/**
 * Coalesces the renderer's many consumers of the same settings snapshot.
 *
 * Electron main remains the only process that discovers or launches provider
 * executables. This boundary merely prevents layered title bars, StrictMode,
 * and secondary panels from sending a herd of identical IPC reads to main.
 */
export async function readDesktopSettingsCoalesced(
  desktopApi: DesktopApi,
  options: { force?: boolean; now?: () => number } = {},
): Promise<ReadDesktopSettingsResponse> {
  if (!desktopApi.readSettings) {
    throw new Error("Settings are unavailable.");
  }
  const now = options.now ?? Date.now;
  const existing = readsByApi.get(desktopApi);
  if (
    existing
    && (
      existing.completedAt === undefined
      || (
        options.force !== true
        && now() - existing.completedAt < RENDERER_SETTINGS_READ_REUSE_TTL_MS
      )
    )
  ) {
    return await existing.promise;
  }

  const entry: SettingsReadEntry = {
    promise: desktopApi.readSettings({}),
  };
  readsByApi.set(desktopApi, entry);
  try {
    const response = await entry.promise;
    entry.completedAt = now();
    return response;
  } catch (error) {
    if (readsByApi.get(desktopApi) === entry) {
      readsByApi.delete(desktopApi);
    }
    throw error;
  }
}

export function rememberDesktopSettingsSnapshot(
  desktopApi: DesktopApi | undefined,
  response: ReadDesktopSettingsResponse,
): void {
  if (!desktopApi) return;
  readsByApi.set(desktopApi, {
    completedAt: Date.now(),
    promise: Promise.resolve(response),
  });
}

export function invalidateDesktopSettingsRead(
  desktopApi: DesktopApi | undefined,
): void {
  if (desktopApi) {
    readsByApi.delete(desktopApi);
  }
}
