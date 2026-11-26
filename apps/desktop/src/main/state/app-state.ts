import {
  ensureActiveProfileDirectory,
  ensureBootstrapProfileDir,
  getProcessRuntimeIdentity,
  resolveActiveProfilePath,
  resolveBootstrapProfilePath,
  startProfileRuntimeHeartbeat,
  type ProfileBootDecision,
  type ProfileRuntimeHeartbeat,
  updateLastUsed,
} from "../profile";
import fs from "node:fs";
import { getMainLogger } from "../log";
import { AppRuntimeInstanceStore } from "../storage/app-runtime-instance-store.js";
import { getAutomationRunOwner } from "../automations/automation-run-owner.js";
import { AutomationStore } from "../storage/automation-store.js";
import { ScheduledThreadActionStore } from "../storage/scheduled-thread-action-store.js";
import { SqliteMessagingStore } from "../storage/messaging-store-sqlite.js";
import { SqliteOverlayStore } from "../storage/overlay-store-sqlite.js";
import { type AutoVacuumConversion, StateDb } from "./state-db.js";

const log = getMainLogger("pwragent:state");
const PROFILE_REGISTRATION_RETRY_MS = 1_000;
let stateDb: StateDb | null = null;
let existingDatabase = false;
export function hadExistingAppStateDatabase(): boolean { return existingDatabase; }
let messagingStore: SqliteMessagingStore | null = null;
let overlayStore: SqliteOverlayStore | null = null;
let runtimeInstanceStore: AppRuntimeInstanceStore | null = null;
let profileRuntimeHeartbeat: ProfileRuntimeHeartbeat | null = null;
let profileRegistrationRetry: NodeJS.Timeout | undefined;
let automationStore: AutomationStore | null = null;
let scheduledThreadActionStore: ScheduledThreadActionStore | null = null;
let activeMode: AppStateMode | null = null;
// Legacy return shape retained for callers; startup no longer vacuums on main.
let autoVacuumConversion: AutoVacuumConversion | null = null;
// The boot decision is set once at startup and stays put for the
// process lifetime. Stored here (vs. recomputed lazily) because the
// wizard's entry-mode signal in the renderer needs to know what the
// boot decision was AT BOOT — recomputing after the wizard creates a
// profile would return `open` and the wizard would lose context.
let currentBootDecision: ProfileBootDecision | null = null;

/**
 * The two flavors of app state init:
 *
 * - `active-profile`: today's flow. The active profile (resolved via
 *   CLI flag / env var / registry / migration) gets its directory
 *   materialized, state.db opened, heartbeat started, last_used
 *   stamped in profiles.toml when available. Used when `resolveProfileBootDecision`
 *   returns `open`.
 *
 * - `bootstrap`: state lives under `.bootstrap/` (sibling to
 *   `profiles/`). No heartbeat, no last_used write, no entry in
 *   profiles.toml. The bootstrap wizard runs against this, and on
 *   Finish the operator's choices graduate into a real profile —
 *   this dir gets cleaned up afterward. Used when
 *   `resolveProfileBootDecision` returns anything except `open`.
 *   See `cleanupBootstrapProfile` in `../profile.ts` for cleanup.
 */
export type AppStateMode = "active-profile" | "bootstrap";

export function recordBootDecision(decision: ProfileBootDecision): void {
  currentBootDecision = decision;
}

export function getBootDecision(): ProfileBootDecision | null {
  return currentBootDecision;
}

function isWindowsRegistryRenameContention(error: unknown): boolean {
  if (!(error instanceof Error) || process.platform !== "win32") return false;
  const { code, syscall } = error as NodeJS.ErrnoException;
  return syscall === "rename" && (code === "EPERM" || code === "EACCES" || code === "EBUSY");
}

function stopProfileRegistrationRetry(): void {
  clearInterval(profileRegistrationRetry);
  profileRegistrationRetry = undefined;
}

function recordProfileStartup(profile: { profileName: string; profileDir: string }): void {
  const { profileName, profileDir } = profile;
  try {
    updateLastUsed(profileName);
  } catch (error) {
    if (!isWindowsRegistryRenameContention(error)) throw error;
    log.warn("Could not record profile startup in the registry", { profileName, error: String(error) });
    // The registry is shared across profiles. Register on a later tick so
    // a Windows reader cannot block startup. Reread the registry on each
    // attempt to pick up changes made while it was busy.
    profileRegistrationRetry = setInterval(() => {
      try {
        if (fs.existsSync(profileDir)) updateLastUsed(profileName, { onlyIfMissing: true });
      } catch (retryError) {
        if (isWindowsRegistryRenameContention(retryError)) return;
        log.warn("Could not register active profile", { profileName, error: String(retryError) });
      }
      stopProfileRegistrationRetry();
    }, PROFILE_REGISTRATION_RETRY_MS).unref();
  }
}

export function initializeAppState(
  mode: AppStateMode = "active-profile",
): {
  autoVacuum: AutoVacuumConversion | null;
  stateDb: StateDb;
  messagingStore: SqliteMessagingStore;
  overlayStore: SqliteOverlayStore;
  runtimeInstanceStore: AppRuntimeInstanceStore;
  mode: AppStateMode;
  automationStore: AutomationStore;
  scheduledThreadActionStore: ScheduledThreadActionStore;
} {
  if (stateDb) {
    if (activeMode !== mode) {
      // Mismatched re-init. Should never happen during a single
      // process lifetime — bootstrap mode is graduated by tearing
      // down state and opening a new window into the real profile,
      // not by flipping the mode in place.
      throw new Error(
        `App state already initialized in mode "${activeMode}"; cannot re-init as "${mode}".`,
      );
    }
    return {
      autoVacuum: autoVacuumConversion,
      stateDb,
      messagingStore: messagingStore!,
      overlayStore: overlayStore!,
      runtimeInstanceStore: runtimeInstanceStore!,
      mode,
      automationStore: automationStore!,
      scheduledThreadActionStore: scheduledThreadActionStore!,
    };
  }

  if (mode === "bootstrap") {
    ensureBootstrapProfileDir();
    const dbPath = resolveBootstrapProfilePath("state/state.db");
    stateDb = StateDb.open(dbPath, { profileName: "__bootstrap__" });
    stateDb.startDeferredGc();
    // Intentionally no profile heartbeat / last_used. The bootstrap
    // profile is transient and must not appear in any user-facing
    // profile listing.
  } else {
    const profile = ensureActiveProfileDirectory();
    const { profileName } = profile;
    const dbPath = resolveActiveProfilePath("state/state.db");
    existingDatabase = fs.existsSync(dbPath);
    stateDb = StateDb.open(dbPath, { profileName });
    stateDb.startDeferredGc();

    recordProfileStartup(profile);
    const processIdentity = getProcessRuntimeIdentity();
    profileRuntimeHeartbeat = startProfileRuntimeHeartbeat(profileName, {
      instanceId: processIdentity.instanceId,
      startedAt: processIdentity.startedAt,
    });
  }

  messagingStore = new SqliteMessagingStore(stateDb);
  overlayStore = new SqliteOverlayStore(stateDb);
  if (mode !== "bootstrap") {
    overlayStore.migrateLegacyLaunchpadExecutionModes();
  }
  runtimeInstanceStore = new AppRuntimeInstanceStore(stateDb);
  // Each run records the process that created it, so a later launch changes
  // only the runs of a process it has proved dead.
  automationStore = new AutomationStore(stateDb, { runOwner: getAutomationRunOwner() });
  scheduledThreadActionStore = new ScheduledThreadActionStore(stateDb);
  activeMode = mode;

  return {
    autoVacuum: autoVacuumConversion,
    stateDb,
    messagingStore: messagingStore!,
    overlayStore: overlayStore!,
    runtimeInstanceStore: runtimeInstanceStore!,
    automationStore: automationStore!,
    scheduledThreadActionStore: scheduledThreadActionStore!,
    mode,
  };
}

export function getAppStateMode(): AppStateMode | null {
  return activeMode;
}

export function getAppStateDb(): StateDb {
  if (!stateDb) throw new Error("App state not initialized. Call initializeAppState() first.");
  return stateDb;
}

export function getAppMessagingStore(): SqliteMessagingStore {
  if (!messagingStore) throw new Error("App state not initialized. Call initializeAppState() first.");
  return messagingStore;
}

export function getAppOverlayStore(): SqliteOverlayStore {
  if (!overlayStore) throw new Error("App state not initialized. Call initializeAppState() first.");
  return overlayStore;
}

export function getAppRuntimeInstanceStore(): AppRuntimeInstanceStore {
  if (!runtimeInstanceStore) throw new Error("App state not initialized. Call initializeAppState() first.");
  return runtimeInstanceStore;
}

export function isAppStateInitialized(): boolean {
  return runtimeInstanceStore !== null;
}

export function getAppAutomationStore(): AutomationStore {
  if (!automationStore) throw new Error("App state not initialized. Call initializeAppState() first.");
  return automationStore;
}

export function getAppScheduledThreadActionStore(): ScheduledThreadActionStore {
  if (!scheduledThreadActionStore) {
    throw new Error("App state not initialized. Call initializeAppState() first.");
  }
  return scheduledThreadActionStore;
}

/**
 * Shutdown has released the runtime: stop profile bookkeeping. The
 * heartbeat marker stays until `disposeAppState` removes it at
 * process exit, and its last write keeps it fresh for the heartbeat TTL.
 */
export function stopProfileRuntimeHeartbeatRefresh(): void {
  stopProfileRegistrationRetry();
  profileRuntimeHeartbeat?.stopRefreshing();
}

export function disposeAppState(): void {
  stopProfileRegistrationRetry();
  if (profileRuntimeHeartbeat) {
    profileRuntimeHeartbeat.stop();
    profileRuntimeHeartbeat = null;
  }
  if (stateDb) {
    stateDb.close();
    stateDb = null;
    existingDatabase = false;
    messagingStore = null;
    overlayStore = null;
    runtimeInstanceStore = null;
    automationStore = null;
    scheduledThreadActionStore = null;
  }
  activeMode = null;
  autoVacuumConversion = null;
}

export function resetAppStateForTests(): void {
  stopProfileRegistrationRetry();
  profileRuntimeHeartbeat?.stop();
  profileRuntimeHeartbeat = null;
  // Close the sqlite handle before dropping the reference. On Windows an open
  // better-sqlite3 file handle keeps a lock that blocks the test harness from
  // removing its temp profile dir (EBUSY on unlink of state.db).
  stateDb?.close();
  stateDb = null;
  existingDatabase = false;
  messagingStore = null;
  overlayStore = null;
  runtimeInstanceStore = null;
  automationStore = null;
  activeMode = null;
  autoVacuumConversion = null;
  currentBootDecision = null;
}
