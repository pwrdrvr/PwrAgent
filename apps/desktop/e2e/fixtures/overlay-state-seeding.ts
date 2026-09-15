// Pre-launch seeder for the overlay state a spec needs the app to boot with:
// launchpad defaults, a registered directory launchpad, a thread overlay.
//
// These three used to be seeded as a legacy `overlay-state.json` under a temp
// `XDG_STATE_HOME`, relying on the pre-profile migration in
// `src/main/state/migration.ts` to import it at boot. That migration is gone —
// no released build ever wrote that layout — so the state goes where the app
// actually reads it from, the profile database.
//
// Pre-launch rather than post-launch (the seam `sub-agent-state-seeding.ts`
// uses) because these specs need the state to exist while the first render
// runs: a directory the Directories lens lists, defaults the launchpad opens
// with, a thread whose recorded branch the drift check compares against.
// `StateDb.open` creates the profile directory and the schema, which is what
// makes seeding before first boot possible at all.
import {
  buildLegacyEncodedThreadIdentityKey,
  type DirectoryLaunchpadOverlayState,
  type NavigationLaunchpadDefaults,
  type ThreadOverlayState,
} from "@pwragent/shared";
import { SqliteOverlayStore } from "../../src/main/state/overlay-store-sqlite";
import { StateDb } from "../../src/main/state/state-db";
import { stateDbPathForHomeRoot } from "./readme-state-seeding";

/**
 * Writes the given overlay state into `<homeRoot>`'s default profile,
 * creating the profile database if this is the first call.
 *
 * Launchpad defaults and directory launchpads go through the app's own
 * `SqliteOverlayStore` writers so the normalization and payload shape keep one
 * owner. Thread overlays have no public whole-overlay writer — `putThread` is
 * private, and the public setters each patch one field and would drag their
 * own side effects in (`replaceWorkspaceLinkedDirectory` also assigns
 * `gitBranch`, which a drift fixture must leave unset) — so the row is
 * written directly, typed as `ThreadOverlayState` so a shape change breaks
 * here at the type level rather than silently seeding a stale payload.
 * `src/main/__tests__/overlay-state-seeding.test.ts` pins that round-trip.
 */
export async function seedProfileOverlayState(
  homeRoot: string,
  params: {
    directoryLaunchpads?: DirectoryLaunchpadOverlayState[];
    launchpadDefaults?: NavigationLaunchpadDefaults;
    threads?: ThreadOverlayState[];
  },
): Promise<void> {
  const stateDb = StateDb.open(stateDbPathForHomeRoot(homeRoot), {
    profileName: "default",
  });
  try {
    const overlay = new SqliteOverlayStore(stateDb);

    if (params.launchpadDefaults) {
      await overlay.setLaunchpadDefaults(params.launchpadDefaults);
    }

    for (const launchpad of params.directoryLaunchpads ?? []) {
      await overlay.upsertDirectoryLaunchpad(launchpad);
    }

    const insertThread = stateDb.raw.prepare(
      `INSERT OR REPLACE INTO threads(thread_id, directory_path, last_seen_at, dismissed_at, snoozed_until, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const thread of params.threads ?? []) {
      insertThread.run(
        // `encodeThreadIdentityKeyForStorage` (private to the store) resolves
        // a well-formed key to this one, so call the shared builder rather
        // than restating its format as a second source of truth.
        buildLegacyEncodedThreadIdentityKey(thread.backend, thread.threadId),
        // `directoryPath` is not on `ThreadOverlayState`; `putThread` reads it
        // off the payload through the same cast, so mirror it rather than
        // dropping the column for an overlay that happens to carry one.
        ((thread as Record<string, unknown>).directoryPath as string) ?? null,
        thread.lastSeenAt ?? null,
        thread.dismissedAt ?? null,
        thread.snoozedUntil ?? null,
        JSON.stringify(thread),
      );
    }
  } finally {
    stateDb.close();
  }
}
