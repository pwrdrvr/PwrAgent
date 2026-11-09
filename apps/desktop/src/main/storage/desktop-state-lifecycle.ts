import type { AutoVacuumConversion } from "./state-db";
import { initializeAppState, type AppStateMode } from "../state/app-state";

export type { AutoVacuumConversion } from "./state-db";
export {
  disposeAppState,
  hadExistingAppStateDatabase,
  isAppStateInitialized,
  recordBootDecision,
  stopProfileRuntimeHeartbeatRefresh,
} from "../state/app-state";
export { SQLITE_WRITE_METRICS_ENV, SQLITE_WRITE_METRICS_FILE_ENV } from "../state/sqlite-write-metrics";

/** Main owns initialization/shutdown; callers receive no store or database. */
export function initializeDesktopState(mode: AppStateMode = "active-profile"): {
  autoVacuum: AutoVacuumConversion | null;
} {
  const { autoVacuum } = initializeAppState(mode);
  return { autoVacuum };
}
