import {
  NATIVE_VOICE_CAMERA_CHANNEL, NATIVE_VOICE_CAMERA_FRAME_CHANNEL,
  NATIVE_VOICE_CAMERA_CUE_CHANNEL, CAMERA_REACTIONS,
  type VoiceCameraRequest, type VoiceCameraFrame, type VoiceCameraCue,
} from "../../shared/native-voice-camera";
import { classifyVoiceCamera } from "../native-voice/clef-camera";
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
// Cold model loading can take a minute or more. Opt-out still aborts immediately.
const CAMERA_WARMUP_TIMEOUT_MS = 5 * 60_000;
const CAMERA_ANALYSIS_TIMEOUT_MS = 8000;
const cameraRequests = new Map<number, { sessionId: string; abort: AbortController }>();
const cameraReadySessions = new Map<number, string>();
function abortCamera(owner: number, sessionId?: string): void {
  if (sessionId === undefined || cameraReadySessions.get(owner) === sessionId) cameraReadySessions.delete(owner);
  const request = cameraRequests.get(owner);
  if (!request || (sessionId !== undefined && request.sessionId !== sessionId)) return;
  request.abort.abort();
  cameraRequests.delete(owner);
}
const owners = new Set<number>();
function observeOwner(sender: WebContents): void {
  const owner = sender.id;
  if (owners.has(owner)) return;
  owners.add(owner);
  const stop = () => {
    abortCamera(owner);
    void sessions.stopOwner(owner).catch(() => undefined);
  };
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
  // Media belongs to the opted-in voice owner. Camera needs a separate opt-in.
  session.defaultSession.setPermissionCheckHandler((contents, permission, _origin, details) => {
    if (permission !== "media") return true;
    return Boolean(contents && details.isMainFrame
      && (details.mediaType === "audio"
        ? sessions.allowsMicrophone(contents.id)
        : details.mediaType === "video" && sessions.allowsCamera(contents.id)));
  });
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== "media") { callback(true); return; }
    callback("mediaTypes" in details && details.mediaTypes?.length === 1 && details.isMainFrame
      && (details.mediaTypes[0] === "audio" ? sessions.allowsMicrophone(contents.id) : details.mediaTypes[0] === "video" && sessions.allowsCamera(contents.id)));
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
      if (notification.type === "closed") abortCamera(event.sender.id, notification.sessionId);
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
    abortCamera(event.sender.id, request.sessionId);
    await sessions.stop(event.sender.id, request);
  });
  ipcMain.handle(NATIVE_VOICE_CAMERA_CHANNEL, async (event, request: VoiceCameraRequest) => {
    validTarget(request);
    if (typeof request.enabled !== "boolean") throw new Error("Invalid camera setting.");
    sessions.setCamera(event.sender.id, request.sessionId, request.enabled);
    if (!request.enabled) abortCamera(event.sender.id, request.sessionId);
  });
  ipcMain.handle(NATIVE_VOICE_CAMERA_CUE_CHANNEL, async (event, request: VoiceCameraCue) => {
    validTarget(request);
    if (request.cue !== "away" && !CAMERA_REACTIONS.includes(request.cue)) throw new Error("Invalid camera cue.");
    await sessions.cameraCue(event.sender.id, request);
  });
  ipcMain.handle(NATIVE_VOICE_CAMERA_FRAME_CHANNEL, async (event, request: VoiceCameraFrame) => {
    validTarget(request);
    if (!sessions.allowsCameraSession(event.sender.id, request.sessionId) || !sessions.allowsCamera(event.sender.id)) {
      throw new Error("Enable the camera in this voice session first.");
    }
    if (typeof request.image !== "string" || request.image.length > 300_000
      || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(request.image)) throw new Error("Invalid camera frame.");
    if (cameraRequests.has(event.sender.id)) throw new Error("A camera frame is already being analyzed.");
    const abort = new AbortController();
    const pending = { sessionId: request.sessionId, abort };
    cameraRequests.set(event.sender.id, pending);
    const warming = cameraReadySessions.get(event.sender.id) !== request.sessionId;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, warming ? CAMERA_WARMUP_TIMEOUT_MS : CAMERA_ANALYSIS_TIMEOUT_MS);
    try {
      const observation = await classifyVoiceCamera(request.image, abort.signal, warming);
      if (!abort.signal.aborted && sessions.allowsCameraSession(event.sender.id, request.sessionId)) {
        cameraReadySessions.set(event.sender.id, request.sessionId);
      }
      return observation;
    }
    catch (error) {
      const message = timedOut
        ? warming
          ? "Clef did not respond within five minutes. Camera cues stopped; voice is still available."
          : "Clef analysis timed out after eight seconds. Camera cues stopped; voice is still available."
        : "Camera cues unavailable. Check that Clef is running at 127.0.0.1:8787.";
      throw new Error(message, { cause: error });
    }
    finally {
      clearTimeout(timeout);
      if (cameraRequests.get(event.sender.id) === pending) cameraRequests.delete(event.sender.id);
    }
  });
  ipcMain.handle(NATIVE_VOICE_TEXT_CHANNEL, async (event, request: NativeVoiceText) => {
    validTarget(request);
    if (typeof request.text !== "string" || !request.text.trim() || request.text.length > 8000) throw new Error("Invalid voice text.");
    await sessions.text(event.sender.id, request);
  });
}
