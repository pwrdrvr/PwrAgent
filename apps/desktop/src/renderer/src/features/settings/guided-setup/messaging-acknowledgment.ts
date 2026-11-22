import type {
  DesktopMessagingAcknowledgment,
  DesktopSettingsConfigPatch,
  DesktopSettingsSnapshot,
} from "@pwragent/shared/contracts/settings";

/**
 * The messaging-safety gate. No messaging provider can be set up from any
 * Settings entry point, guided or dense, until the operator has read the
 * three safety principles and an acknowledgement is on record in
 * `general.messaging_acknowledgment`.
 *
 * Only a stored record lifts the gate. A ticked checkbox does not: the
 * operator might close the window before the write lands, and a second
 * window reads the same profile.
 */
export function isMessagingAcknowledged(
  snapshot: DesktopSettingsSnapshot | undefined,
): boolean {
  const record = snapshot?.general.messagingAcknowledgment.value;
  return Boolean(record?.acknowledgedAt);
}

/**
 * The config patch that puts an acknowledgement on record. The shape is the
 * one first-run setup has always written: when it was acknowledged, and the
 * providers the operator was setting up at the time.
 */
export function messagingAcknowledgmentPatch(
  providers: readonly string[],
  now: Date = new Date(),
): DesktopSettingsConfigPatch {
  return {
    general: {
      messagingAcknowledgment: {
        acknowledgedAt: now.toISOString(),
        providers: uniqueProviders(providers),
      },
    },
  };
}

/**
 * Add providers set up later to an existing record. The original
 * `acknowledgedAt` stays: it records when the operator read the principles,
 * not when they last connected something. Returns `undefined` when there is
 * no record, or nothing new to add, so callers write nothing.
 */
export function messagingAcknowledgmentWithProviders(
  current: DesktopMessagingAcknowledgment | null | undefined,
  providers: readonly string[],
): DesktopSettingsConfigPatch | undefined {
  if (!current?.acknowledgedAt) return undefined;
  const merged = uniqueProviders([...current.providers, ...providers]);
  if (merged.length === uniqueProviders(current.providers).length) {
    return undefined;
  }
  return {
    general: {
      messagingAcknowledgment: {
        acknowledgedAt: current.acknowledgedAt,
        providers: merged,
      },
    },
  };
}

function uniqueProviders(providers: readonly string[]): string[] {
  return [...new Set(providers.filter((provider) => provider.length > 0))];
}
