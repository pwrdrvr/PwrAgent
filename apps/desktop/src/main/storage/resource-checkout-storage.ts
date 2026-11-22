import path from "node:path";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";

export function openMachineCheckoutStorage(root: string, identity: string) {
  return openResourceCheckoutStore(path.join(root, "resource-checkouts.db"), identity);
}

export function openFederationCheckoutStorage(root: string, identity: string) {
  return openResourceCheckoutStore(path.join(root, "federation-resource-checkouts.db"), identity);
}
