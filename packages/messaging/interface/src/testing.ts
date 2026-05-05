// Test-only fixtures and helpers for the messaging interface.
//
// Imported via `@pwragent/messaging-interface/testing`. Production code must
// not import from this module — capability profiles in production should
// come from a real provider's profile declaration, not from a permissive
// catch-all that bypasses capability discovery.

import type { MessagingCapabilityProfile } from "./index.js";

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
};
