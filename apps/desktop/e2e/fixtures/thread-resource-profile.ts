import type { StateDb } from "@pwragent/sqlite-storage/state-db";

// The profile selector is the only test substitution in the factory bundle.
let selected: StateDb | undefined;
export function selectResourceProfile(db: StateDb | undefined): void { selected = db; }
export function getAppStateDb(): StateDb {
  if (!selected) throw new Error("No resource fixture profile selected");
  return selected;
}
export function getAppStateMode() { return selected ? "profile" as const : null; }
export function getAppOverlayStore(): never { throw new Error("No overlay selection in this fixture"); }
export function getAppRuntimeInstanceStore(): never { throw new Error("No runtime leases in this fixture"); }
export function getBootDecision(): never { throw new Error("No boot selection in this fixture"); }
export function isAppStateInitialized() { return Boolean(selected); }
export function getAppScheduledThreadActionStore(): never { throw new Error("No scheduled action service in this fixture"); }
