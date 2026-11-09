import type { StateDb } from "@pwragent/sqlite-storage/state-db";

// Test-owned app-state selection for the original factory, bundled only by
// shared-messaging-request-profile.spec.ts. The production app is untouched.
let selected: StateDb | undefined;
export function selectRequestProfile(db: StateDb | undefined): void { selected = db; }
export function getAppStateDb(): StateDb {
  if (!selected) throw new Error("No request fixture profile selected");
  return selected;
}
export function getAppMessagingStore(): never { throw new Error("No messaging adapter in this fixture"); }
