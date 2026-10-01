import type { OperatorFocusSnapshot } from "@pwragent/shared";

/** Window-local voice ownership. No credentials or service URLs cross IPC. */
export const NATIVE_VOICE_CAPABILITY_CHANNEL = "native-voice:capability";
export const NATIVE_VOICE_START_CHANNEL = "native-voice:start";
export const NATIVE_VOICE_STOP_CHANNEL = "native-voice:stop";
export const NATIVE_VOICE_TEXT_CHANNEL = "native-voice:text";
export const NATIVE_VOICE_EVENT_CHANNEL = "native-voice:event";
/** Resolve (creating on first use) the thread overseer voice talks through. */
export const NATIVE_VOICE_OPEN_MANAGER_CHANNEL = "native-voice:open-manager";
/** Main window → main: what the operator is looking at, for `read_operator_focus`. */
export const OPERATOR_FOCUS_PUBLISH_CHANNEL = "operator-focus:publish";

/**
 * `thread` talks to the thread whose composer started it and ends when the
 * operator leaves that thread. `overseer` talks to the Voice manager thread,
 * whose tools reach every thread, and survives navigation.
 */
export type NativeVoiceMode = "thread" | "overseer";

export type NativeVoiceCapability = { available: boolean; reason?: string };
export type NativeVoiceStart = { threadId: string; sessionId: string; sdp: string; mode?: NativeVoiceMode };
export type NativeVoiceTarget = { sessionId: string };
export type NativeVoiceText = NativeVoiceTarget & { text: string };
/** A PwrAgent tool the voice session's thread ran, reported as it settled. */
export type NativeVoiceAction = {
  tool: string;
  ok: boolean;
  /** The thread the tool acted on, when its result names one. */
  target?: string;
  /** The machine that owns `target`, when it is a peer. */
  instance?: string;
  /** What the tool reported doing: queued, steered, started, stopped. */
  outcome?: string;
};
export type NativeVoiceEvent = { sessionId: string } & (
  | { type: "sdp"; sdp: string }
  | { type: "started"; version: string }
  | { type: "transcript"; role: string; text: string; done: boolean }
  | ({ type: "action" } & NativeVoiceAction)
  | { type: "closed"; reason?: string }
  | { type: "error"; message: string }
);
export type OpenVoiceManagerResponse =
  | { status: "ready"; threadId: string; created: boolean }
  | { status: "failed"; error: string };
export type NativeVoiceApi = {
  nativeVoiceCapability: () => Promise<NativeVoiceCapability>;
  startNativeVoice: (request: NativeVoiceStart) => Promise<void>;
  stopNativeVoice: (request: NativeVoiceTarget) => Promise<void>;
  sendNativeVoiceText: (request: NativeVoiceText) => Promise<void>;
  onNativeVoiceEvent: (callback: (event: NativeVoiceEvent) => void) => () => void;
  openVoiceManager?: () => Promise<OpenVoiceManagerResponse>;
  publishOperatorFocus?: (focus: OperatorFocusSnapshot) => Promise<void>;
};
