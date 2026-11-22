import { describe, expect, it } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared/contracts/settings";
import {
  isMessagingAcknowledged,
  messagingAcknowledgmentPatch,
  messagingAcknowledgmentWithProviders,
} from "../messaging-acknowledgment";

function snapshotWith(
  value: DesktopSettingsSnapshot["general"]["messagingAcknowledgment"]["value"],
): DesktopSettingsSnapshot {
  return {
    general: { messagingAcknowledgment: { value, source: "config" } },
  } as unknown as DesktopSettingsSnapshot;
}

describe("messaging acknowledgement record", () => {
  it("writes the shape first-run setup writes", () => {
    const now = new Date("2026-11-21T10:11:12.000Z");
    expect(messagingAcknowledgmentPatch(["telegram", "telegram", "slack"], now))
      .toEqual({
        general: {
          messagingAcknowledgment: {
            acknowledgedAt: "2026-11-21T10:11:12.000Z",
            providers: ["telegram", "slack"],
          },
        },
      });
  });

  it("is on record only with a stored timestamp", () => {
    expect(isMessagingAcknowledged(undefined)).toBe(false);
    expect(isMessagingAcknowledged(snapshotWith(null))).toBe(false);
    expect(
      isMessagingAcknowledged(snapshotWith({ acknowledgedAt: "", providers: [] })),
    ).toBe(false);
    expect(
      isMessagingAcknowledged(
        snapshotWith({ acknowledgedAt: "2026-01-01T00:00:00.000Z", providers: [] }),
      ),
    ).toBe(true);
  });

  it("adds providers later without moving the acknowledgement time", () => {
    const current = {
      acknowledgedAt: "2026-01-01T00:00:00.000Z",
      providers: ["telegram"],
    };
    expect(messagingAcknowledgmentWithProviders(current, ["telegram", "discord"]))
      .toEqual({
        general: {
          messagingAcknowledgment: {
            acknowledgedAt: "2026-01-01T00:00:00.000Z",
            providers: ["telegram", "discord"],
          },
        },
      });
    expect(messagingAcknowledgmentWithProviders(current, ["telegram"])).toBeUndefined();
    // Never creates a record: only the safety screen does that.
    expect(messagingAcknowledgmentWithProviders(null, ["telegram"])).toBeUndefined();
  });
});
