// Messaging primitives that live in @pwragent/shared because shared internals
// (e.g. settings) need them. Everything else messaging-related — intents,
// surfaces, capability profile, attachments, callbacks — lives in
// @pwragent/messaging-interface, which re-exports these primitives so
// consumers see a single canonical type set.

export const MESSAGING_TOOL_UPDATE_MODES = [
  "show_none",
  "show_less",
  "show_some",
  "show_more",
  "show_all",
] as const;

export type MessagingToolUpdateMode = (typeof MESSAGING_TOOL_UPDATE_MODES)[number];
