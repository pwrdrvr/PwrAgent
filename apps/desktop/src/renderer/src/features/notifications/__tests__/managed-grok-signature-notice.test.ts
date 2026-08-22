import { describe, expect, it, vi } from "vitest";

import type { ManagedGrokSignatureRejectedEvent } from "../../../../../shared/managed-grok-signature";
import { buildManagedGrokSignatureRejectedNotice } from "../managed-grok-signature-notice";

const event: ManagedGrokSignatureRejectedEvent = {
  detail: "Managed Grok bundle signature does not match this PwrAgent build: signer mismatch",
  directory: "/Users/me/.pwragent/agents/grok/versions/pwragent-v1.0.4-pwragent.2",
  id: "rejection-1",
  occurredAt: 1_700_000_000_000,
  removed: true,
  stage: "installed",
  tag: "pwragent-v1.0.4-pwragent.2",
};

describe("buildManagedGrokSignatureRejectedNotice", () => {
  // The download resolves behind whatever screen the operator was on, so an
  // auto-dismissing toast could expire before anyone is looking at it.
  it("never auto-dismisses", () => {
    const notice = buildManagedGrokSignatureRejectedNotice({
      event,
      onDismiss: vi.fn(),
    });

    expect(notice.autoDismiss).toBe(false);
    expect(notice.tone).toBe("error");
    expect(notice.id).toBe(`managed-grok-signature:${event.directory}`);
    expect(notice.title).toContain("rejected");
    expect(notice.message).toContain(event.tag);
    expect(notice.detail).toContain("during this validation attempt");
    expect(notice.detail).not.toContain("never run");
    expect(notice.message).not.toContain("unavailable");
    expect(notice.copyText).toBe(event.detail);
  });

  // A bundle we could not delete is a different instruction to the operator.
  it("says so when the rejected bundle could not be removed", () => {
    const notice = buildManagedGrokSignatureRejectedNotice({
      event: { ...event, removed: false },
      onDismiss: vi.fn(),
    });

    expect(notice.detail).toContain("remove it manually");
    expect(notice.detail).toContain("during this validation attempt");
  });

  it("says a staged download was deleted before installation", () => {
    const notice = buildManagedGrokSignatureRejectedNotice({
      event: { ...event, stage: "download" },
      onDismiss: vi.fn(),
    });

    expect(notice.title).toContain("download rejected");
    expect(notice.detail).toContain("before installation");
    expect(notice.detail).not.toContain("never run");
  });

  it("omits the release name when the tag is unknown", () => {
    const notice = buildManagedGrokSignatureRejectedNotice({
      event: { ...event, tag: undefined },
      onDismiss: vi.fn(),
    });

    expect(notice.message).toContain("The installed Grok runtime is not signed");
  });
});
