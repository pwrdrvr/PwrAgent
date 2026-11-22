import path from "node:path";
import { openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";

export { CheckoutStoreIdentityError } from "@pwragent/sqlite-storage/resource-checkout-store";

export function openMachineCheckoutStorage(root: string, identity: string, options?: { adoptIdentity?: boolean }) {
  return openResourceCheckoutStore(path.join(root, "resource-checkouts.db"), identity, options);
}

export function openFederationCheckoutStorage(root: string, identity: string) {
  return openResourceCheckoutStore(path.join(root, "federation-resource-checkouts.db"), identity);
}
