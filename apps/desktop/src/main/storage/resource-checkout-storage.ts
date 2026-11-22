import path from "node:path";
import { CheckoutStoreIdentityError, openResourceCheckoutStore } from "@pwragent/sqlite-storage/resource-checkout-store";

export { CheckoutStoreIdentityError };

export function openMachineCheckoutStorage(root: string, identity: string, options?: { adoptIdentity?: boolean }) {
  return openResourceCheckoutStore(path.join(root, "resource-checkouts.db"), identity, options);
}

/**
 * Open the machine store for an operator who chose to keep a copied root on
 * this machine. `adopted` is false when another profile on the root already
 * took it over: the checkouts made since then are real.
 */
export function adoptMachineCheckoutStorage(root: string, identity: string) {
  try {
    return { store: openMachineCheckoutStorage(root, identity), adopted: false };
  } catch (error) {
    if (!(error instanceof CheckoutStoreIdentityError)) throw error;
    return { store: openMachineCheckoutStorage(root, identity, { adoptIdentity: true }), adopted: true };
  }
}

export function openFederationCheckoutStorage(root: string, identity: string) {
  return openResourceCheckoutStore(path.join(root, "federation-resource-checkouts.db"), identity);
}
