const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The creation time, in epoch milliseconds, that a UUIDv7 carries in its
 * leading 48 bits. Codex turn ids are UUIDv7. Any other id is opaque: a
 * UUIDv4 (Claude turn ids) has random leading bits, which read as a date
 * thousands of years from now.
 */
export function readUuidV7Timestamp(id: string | undefined): number | undefined {
  if (!id || !UUID_V7_PATTERN.test(id)) {
    return undefined;
  }
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}
