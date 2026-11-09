import type { OperatorRequestStorage } from "@pwragent/owner-core/operator-request-storage";
import { getAppStateDb } from "../state/app-state";
import { OperatorRequestStore } from "./operator-request-store";

// Bind once when the application constructs its service, as before.
export function createOperatorRequestStorage(): OperatorRequestStorage {
  return new OperatorRequestStore(getAppStateDb());
}
