// Test-only fixtures and helpers for the messaging interface.
//
// Imported via `@pwragent/messaging-interface/testing`. Production code must
// not import from this module — capability profiles in production should
// come from a real provider's profile declaration, not from a permissive
// catch-all that bypasses capability discovery.

import type {
  MessagingCapabilityProfile,
  MessagingInboundRejectedListener,
  MessagingRejectedInboundEvent,
} from "./index.js";

/**
 * A capability profile that advertises generous limits and full feature
 * support across all dimensions. Use only in tests where the real provider
 * profile is irrelevant. In production, every adapter must declare its
 * actual capability profile.
 */
export const PERMISSIVE_CAPABILITY_PROFILE: MessagingCapabilityProfile = {
  actions: {
    maxActions: 100,
    maxActionsPerRow: 8,
    maxLabelLength: 256,
    supportsStyles: true,
    supportsDisabled: true,
    supportsLayoutHints: true,
    maxCallbackPayloadBytes: 256,
  },
  text: {
    maxLength: 16384,
    encoding: "characters",
    markdownDialect: "markdown",
    supportsCodeBlocks: true,
    supportsBold: true,
    supportsItalic: true,
    supportsLinks: true,
    supportsInlineCode: true,
    supportsMessageEdit: true,
  },
  conversationInput: {
    reportsBotMention: true,
  },
  outboundAttachments: {
    maxUploadBytes: 100 * 1024 * 1024,
    supportsFileUpload: true,
    supportsImageUpload: true,
    supportsRemoteImageUrl: true,
  },
};

/**
 * Inbound-rejected listeners that fail in both ways an adapter must survive,
 * followed by one that records what it receives. Register them in order, call
 * `watch()` before the rejection is triggered, and `settle()` after it.
 *
 * `received` holds the events the healthy listener saw. `unhandled` holds any
 * promise rejection that escaped the adapter. `errors` holds what the throwing
 * and rejecting listeners raised, so a test can check the adapter logged them.
 */
export function failingInboundRejectedListeners() {
  const received: MessagingRejectedInboundEvent[] = [];
  const unhandled: unknown[] = [];
  const errors = [
    new Error("inbound-rejected listener threw"),
    new Error("inbound-rejected listener rejected"),
  ];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  const listeners: MessagingInboundRejectedListener[] = [
    () => {
      throw errors[0];
    },
    async () => {
      throw errors[1];
    },
    (event) => {
      received.push(event);
    },
  ];
  return {
    errors,
    listeners,
    received,
    unhandled,
    watch(): void {
      process.on("unhandledRejection", onUnhandled);
    },
    async settle(): Promise<void> {
      // Node reports an unhandled rejection after the microtask queue drains.
      await new Promise((resolve) => setTimeout(resolve, 20));
      process.off("unhandledRejection", onUnhandled);
    },
  };
}
