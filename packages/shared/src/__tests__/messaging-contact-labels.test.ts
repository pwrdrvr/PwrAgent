import { describe, expect, it } from "vitest";
import {
  MESSAGING_CONTACT_LABEL_MAX_LENGTH,
  sanitizeMessagingContactHandle,
  sanitizeMessagingContactLabel,
} from "../messaging-contact-labels";

describe("messaging contact label sanitization", () => {
  it("keeps recognizable plain contact labels", () => {
    expect(sanitizeMessagingContactLabel("Harold Hunt (@huntharo)")).toBe(
      "Harold Hunt (@huntharo)",
    );
  });

  it("keeps non-latin names and normalizes whitespace", () => {
    expect(sanitizeMessagingContactLabel("  山田   太郎  ")).toBe("山田 太郎");
  });

  it("removes markup, controls, bidi controls, and injection punctuation", () => {
    const sanitized = sanitizeMessagingContactLabel(
      "<img src=x onerror=alert(1)> Robert'); DROP TABLE users;-- \u202eevil",
    );

    expect(sanitized).toBe("Robert) DROP TABLE users- evil");
    expect(sanitized).not.toMatch(/[<>"'`;=\\/\u202e]/u);
  });

  it("strips script bodies instead of retaining executable text", () => {
    expect(
      sanitizeMessagingContactLabel("Alice <script>alert(1)</script> Bob"),
    ).toBe("Alice Bob");
  });

  it("caps labels before persisting them", () => {
    expect(sanitizeMessagingContactLabel("a".repeat(200))).toHaveLength(
      MESSAGING_CONTACT_LABEL_MAX_LENGTH,
    );
  });

  it("sanitizes handles without adding an at-sign", () => {
    expect(sanitizeMessagingContactHandle("@hun<tharo> user")).toBe(
      "hunuser",
    );
  });
});
