import { ipcMain, session, type WebContents } from "electron";
import {
  NATIVE_VOICE_CAPABILITY_CHANNEL, NATIVE_VOICE_START_CHANNEL,
  NATIVE_VOICE_STOP_CHANNEL, NATIVE_VOICE_TEXT_CHANNEL, NATIVE_VOICE_EVENT_CHANNEL,
  NATIVE_VOICE_OPEN_MANAGER_CHANNEL, OPERATOR_FOCUS_PUBLISH_CHANNEL,
  type NativeVoiceStart, type NativeVoiceTarget, type NativeVoiceText,
} from "../../shared/native-voice";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { NativeVoiceSessionManager } from "../codex-app-server/native-voice-session";
import { isVoiceManagerThread, openVoiceManagerThread } from "../native-voice/voice-manager-thread";
import { isOperatorFocusSnapshot, publishOperatorFocus } from "../native-voice/operator-focus-registry";
import { isLocalMainWindowWebContents } from "../window-channels";

const sessions = new NativeVoiceSessionManager((threadId) => getDesktopBackendRegistry().acquireNativeVoiceBackend(threadId));
const owners = new Set<number>();
function observeOwner(sender: WebContents): void {
  const owner = sender.id;
  if (owners.has(owner)) return;
  owners.add(owner);
  const stop = () => { void sessions.stopOwner(owner).catch(() => undefined); };
  sender.on("render-process-gone", stop);
  sender.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => { if (mainFrame) stop(); });
  sender.once("destroyed", () => { owners.delete(owner); stop(); });
}
function validTarget(request: NativeVoiceTarget): void {
  if (!request || typeof request.sessionId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(request.sessionId)) {
    throw new Error("Invalid voice session.");
  }
}
export function registerNativeVoiceIpcHandlers(): void {
  // Electron otherwise grants media to any renderer. Only the opted-in voice
  // owner may capture audio; camera requests are never part of this feature.
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (permission !== "media") return true;
    return Boolean(contents && details.isMainFrame && details.mediaType === "audio" && sessions.allowsMicrophone(contents.id));
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== "media") { callback(true); return; }
    callback("mediaTypes" in details && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "audio"
      && details.isMainFrame && sessions.allowsMicrophone(contents.id));
  });
  ipcMain.handle(NATIVE_VOICE_CAPABILITY_CHANNEL, async () => {
    try { return await getDesktopBackendRegistry().nativeVoiceCapability(); }
    catch { return { available: false, reason: "Connect and sign in to Codex before starting voice." }; }
  });
  ipcMain.handle(NATIVE_VOICE_START_CHANNEL, async (event, request: NativeVoiceStart) => {
    validTarget(request);
    if (typeof request.threadId !== "string" || request.threadId.length > 200 || !request.threadId
      || typeof request.sdp !== "string" || request.sdp.length > 100_000 || !request.sdp.startsWith("v=0")) {
      throw new Error("Invalid WebRTC voice offer.");
    }
    if (request.mode !== undefined && request.mode !== "thread" && request.mode !== "director") {
      throw new Error("Invalid voice mode.");
    }
    // Director voice is told it can act on every thread; only the Voice
    // manager thread is given that prompt.
    if (request.mode === "director" && !isVoiceManagerThread(request.threadId)) {
      throw new Error("Director voice runs only on the Voice manager thread.");
    }
    observeOwner(event.sender);
    await sessions.start(event.sender.id, request, (notification) => {
      if (!event.sender.isDestroyed()) event.sender.send(NATIVE_VOICE_EVENT_CHANNEL, notification);
    });
  });
  ipcMain.handle(NATIVE_VOICE_OPEN_MANAGER_CHANNEL, async (event) => {
    // Local only: director voice reaches peers through its tools.
    if (!isLocalMainWindowWebContents(event.sender)) {
      return { status: "failed", error: "Director voice is available from a local main window." };
    }
    return await openVoiceManagerThread();
  });
  ipcMain.handle(OPERATOR_FOCUS_PUBLISH_CHANNEL, async (event, focus: unknown) => {
    // The sender is checked, not just the payload: the preload is shared by
    // every window, and this is served to a model as the operator's screen.
    if (!isLocalMainWindowWebContents(event.sender) || !isOperatorFocusSnapshot(focus)) return;
    publishOperatorFocus({ focus, webContents: event.sender });
  });
  ipcMain.handle(NATIVE_VOICE_STOP_CHANNEL, async (event, request: NativeVoiceTarget) => {
    validTarget(request);
    await sessions.stop(event.sender.id, request);
  });
  ipcMain.handle(NATIVE_VOICE_TEXT_CHANNEL, async (event, request: NativeVoiceText) => {
    validTarget(request);
    if (typeof request.text !== "string" || !request.text.trim() || request.text.length > 8000) throw new Error("Invalid voice text.");
    await sessions.text(event.sender.id, request);
  });
}
