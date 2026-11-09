import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { NativeVoiceSessionManager } from "../codex-app-server/native-voice-session";

/** Desktop windows and paired phones share one billed-session owner. */
let sessions: NativeVoiceSessionManager | undefined;
export function getNativeVoiceSessions(): NativeVoiceSessionManager {
  return sessions ??= new NativeVoiceSessionManager((threadId) => getDesktopBackendRegistry().acquireNativeVoiceBackend(threadId));
}
