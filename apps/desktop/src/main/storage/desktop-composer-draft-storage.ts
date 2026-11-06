import type { ComposerDraftStorage } from "@pwragent/owner-core/composer-draft-storage";
import { getAppStateDb } from "../state/app-state";
import { ComposerDraftRecoveryStore } from "../state/composer-draft-recovery-store";

// Resolve the current profile at the application's existing per-call boundary.
export function createComposerDraftStorage(): ComposerDraftStorage {
  return new ComposerDraftRecoveryStore(getAppStateDb());
}
