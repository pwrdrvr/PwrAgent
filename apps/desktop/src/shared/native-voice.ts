/** Window-local voice ownership. No credentials or service URLs cross IPC. */
export const NATIVE_VOICE_CAPABILITY_CHANNEL = "native-voice:capability";
export const NATIVE_VOICE_START_CHANNEL = "native-voice:start";
export const NATIVE_VOICE_STOP_CHANNEL = "native-voice:stop";
export const NATIVE_VOICE_TEXT_CHANNEL = "native-voice:text";
export const NATIVE_VOICE_EVENT_CHANNEL = "native-voice:event";

export type NativeVoiceCapability = { available: boolean; reason?: string };
export type NativeVoiceStart = { threadId: string; sessionId: string; sdp: string };
export type NativeVoiceTarget = { sessionId: string };
export type NativeVoiceText = NativeVoiceTarget & { text: string };
export type NativeVoiceEvent = { sessionId: string } & (
  | { type: "sdp"; sdp: string }
  | { type: "started"; version: string }
  | { type: "transcript"; role: string; text: string; done: boolean }
  | { type: "closed"; reason?: string }
  | { type: "error"; message: string }
);
export type NativeVoiceApi = {
  nativeVoiceCapability: () => Promise<NativeVoiceCapability>;
  startNativeVoice: (request: NativeVoiceStart) => Promise<void>;
  stopNativeVoice: (request: NativeVoiceTarget) => Promise<void>;
  sendNativeVoiceText: (request: NativeVoiceText) => Promise<void>;
  onNativeVoiceEvent: (callback: (event: NativeVoiceEvent) => void) => () => void;
};
