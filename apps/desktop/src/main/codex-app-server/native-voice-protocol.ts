import type { ServerNotification } from "@pwrdrvr/codex-app-server-protocol";
import type { ThreadRealtimeStartParams } from "@pwrdrvr/codex-app-server-protocol/v2";

export type NativeVoiceNotification = Extract<ServerNotification, {
  method: `thread/realtime/${string}`;
}>;
/** The lease keeps the selected App Server alive and its tool catalog attached. */
export type NativeVoiceBackend = {
  start: (params: ThreadRealtimeStartParams) => Promise<void>;
  stop: (threadId: string) => Promise<void>;
  text: (threadId: string, text: string) => Promise<void>;
  onEvent: (listener: (event: NativeVoiceNotification) => void) => () => void;
  onDisconnect: (listener: () => void) => () => void;
  release: () => void;
};

export function supportsNativeVoice(userAgent?: string): boolean {
  const match = userAgent?.match(/(?:^|\s)codex[^/\s]*\/(\d+)\.(\d+)\.(\d+)/i);
  return Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 159));
}
