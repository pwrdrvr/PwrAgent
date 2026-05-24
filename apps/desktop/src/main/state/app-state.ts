import {
  ensureBootstrapProfileDir,
  ensureProfileExists,
  resolveActiveProfilePath,
  resolveBootstrapProfilePath,
  startProfileRuntimeHeartbeat,
  type ProfileBootDecision,
  type ProfileRuntimeHeartbeat,
  updateLastUsed,
} from "../profile";
import { AppRuntimeInstanceStore } from "./app-runtime-instance-store.js";
import { AutomationStore } from "../automations/automation-store.js";
import { migrateIfNeeded } from "./migration.js";
import { SqliteMessagingStore } from "./messaging-store-sqlite.js";
import { SqliteOverlayStore } from "./overlay-store-sqlite.js";
import { StateDb } from "./state-db.js";

let stateDb: StateDb | null = null;
let messagingStore: SqliteMessagingStore | null = null;
let overlayStore: SqliteOverlayStore | null = null;
let runtimeInstanceStore: AppRuntimeInstanceStore | null = null;
let profileRuntimeHeartbeat: ProfileRuntimeHeartbeat | null = null;
let automationStore: AutomationStore | null = null;
let activeMode: AppStateMode | null = null;
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
 *   stamped in profiles.toml. Used when `resolveProfileBootDecision`
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

export function initializeAppState(
  mode: AppStateMode = "active-profile",
): {
  stateDb: StateDb;
  messagingStore: SqliteMessagingStore;
  overlayStore: SqliteOverlayStore;
  runtimeInstanceStore: AppRuntimeInstanceStore;
  mode: AppStateMode;
  automationStore: AutomationStore;
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
      stateDb,
      messagingStore: messagingStore!,
      overlayStore: overlayStore!,
      runtimeInstanceStore: runtimeInstanceStore!,
      mode,
      automationStore: automationStore!,
    };
  }

  if (mode === "bootstrap") {
    ensureBootstrapProfileDir();
    // Intentionally skip `migrateIfNeeded` — the bootstrap profile
    // is freshly minted each onboarding session and has no legacy
    // XDG paths to migrate from. Real-profile migration runs when
    // the operator's chosen profile gets initialized on graduation.
    const dbPath = resolveBootstrapProfilePath("state/state.db");
    stateDb = StateDb.open(dbPath, { profileName: "__bootstrap__" });
    stateDb.startGc();
    // Intentionally no profile heartbeat / last_used. The bootstrap
    // profile is transient and must not appear in any user-facing
    // profile listing.
  } else {
    const { profileName } = ensureProfileExists();
    migrateIfNeeded();

    const dbPath = resolveActiveProfilePath("state/state.db");
    stateDb = StateDb.open(dbPath, { profileName });
    stateDb.startGc();

    updateLastUsed(profileName);
    profileRuntimeHeartbeat = startProfileRuntimeHeartbeat(profileName);
  }

  messagingStore = new SqliteMessagingStore(stateDb);
  overlayStore = new SqliteOverlayStore(stateDb);
  runtimeInstanceStore = new AppRuntimeInstanceStore(stateDb);
  automationStore = new AutomationStore(stateDb);
  activeMode = mode;

  return {
    stateDb,
    messagingStore: messagingStore!,
    overlayStore: overlayStore!,
    runtimeInstanceStore: runtimeInstanceStore!,
    automationStore: automationStore!,
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

export function disposeAppState(): void {
  if (profileRuntimeHeartbeat) {
    profileRuntimeHeartbeat.stop();
    profileRuntimeHeartbeat = null;
  }
  if (stateDb) {
    stateDb.close();
    stateDb = null;
    messagingStore = null;
    overlayStore = null;
    runtimeInstanceStore = null;
    automationStore = null;
  }
  activeMode = null;
}

export function resetAppStateForTests(): void {
  profileRuntimeHeartbeat?.stop();
  profileRuntimeHeartbeat = null;
  stateDb = null;
  messagingStore = null;
  overlayStore = null;
  runtimeInstanceStore = null;
  automationStore = null;
  activeMode = null;
  currentBootDecision = null;
}
