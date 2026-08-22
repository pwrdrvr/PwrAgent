import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

import {
  MANAGED_GROK_SIGNATURE_REJECTION_ACKNOWLEDGE_CHANNEL,
  MANAGED_GROK_SIGNATURE_REJECTIONS_READ_CHANNEL,
} from "../../shared/ipc";
import type { ManagedGrokSignatureRejectedEvent } from "../../shared/managed-grok-signature";
import {
  _resetPendingManagedGrokSignatureRejectionsForTests,
  broadcastManagedGrokSignatureRejection,
  registerManagedGrokSignatureRejectionBroadcast,
} from "../managed-grok-signature-broadcast";

const rejection: ManagedGrokSignatureRejectedEvent = {
  detail: "signer mismatch",
  directory: "/managed/grok/rejected",
  id: "rejection-1",
  occurredAt: 1_700_000_000_000,
  removed: true,
  stage: "download",
  tag: "pwragent-v1.0.4-pwragent.2",
};

describe("managed Grok signature rejection broadcast", () => {
  beforeEach(() => {
    handlers.clear();
    _resetPendingManagedGrokSignatureRejectionsForTests();
  });

  it("retains a rejection until a renderer reads and acknowledges it", () => {
    registerManagedGrokSignatureRejectionBroadcast();

    // No window or renderer subscription exists yet.
    broadcastManagedGrokSignatureRejection(rejection);

    const read = handlers.get(MANAGED_GROK_SIGNATURE_REJECTIONS_READ_CHANNEL);
    const acknowledge = handlers.get(
      MANAGED_GROK_SIGNATURE_REJECTION_ACKNOWLEDGE_CHANNEL,
    );
    expect(read?.({})).toEqual([rejection]);
    expect(read?.({})).toEqual([rejection]);

    acknowledge?.({}, rejection.id);

    expect(read?.({})).toEqual([]);
  });
});
