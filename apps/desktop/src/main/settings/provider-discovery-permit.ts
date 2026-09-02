const PROVIDER_DISCOVERY_PERMIT = Symbol("provider-discovery-permit");

export type ProviderDiscoveryIntent =
  | "startup"
  | "settings-user-action"
  | "setup-user-action";

/**
 * Runtime capability required by every operation that may probe or launch an
 * AI provider for discovery. The symbol is private to this module, so a plain
 * object or renderer request cannot manufacture a valid permit.
 *
 * Production permit issuance is additionally source-boundary tested: only the
 * startup coordinator and the Settings/setup IPC handlers may call
 * `issueProviderDiscoveryPermit`.
 */
export type ProviderDiscoveryPermit = Readonly<{
  intent: ProviderDiscoveryIntent;
  [PROVIDER_DISCOVERY_PERMIT]: true;
}>;

export function issueProviderDiscoveryPermit(
  intent: ProviderDiscoveryIntent,
): ProviderDiscoveryPermit {
  return Object.freeze({
    intent,
    [PROVIDER_DISCOVERY_PERMIT]: true as const,
  });
}

export function assertProviderDiscoveryPermit(
  permit: ProviderDiscoveryPermit | undefined,
  allowedIntents?: readonly ProviderDiscoveryIntent[],
): asserts permit is ProviderDiscoveryPermit {
  if (!permit || permit[PROVIDER_DISCOVERY_PERMIT] !== true) {
    throw new Error("Provider discovery requires an explicit discovery permit.");
  }
  if (allowedIntents && !allowedIntents.includes(permit.intent)) {
    throw new Error(
      `Provider discovery intent ${permit.intent} is not allowed here.`,
    );
  }
}
