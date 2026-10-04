import {
  NATIVE_VOICE_CAMERA_CHANNEL, NATIVE_VOICE_CAMERA_FRAME_CHANNEL,
  NATIVE_VOICE_CAMERA_CUE_CHANNEL, NATIVE_VOICE_CAMERA_REPEAT_CHANNEL, VOICE_CAMERA_BURST, isCameraCue, isCameraConversation,
  type VoiceCameraRequest, type VoiceCameraFrame, type VoiceCameraCue, type VoiceCameraSkipped,
  type VoiceCameraRepeatCheck, type VoiceCameraRepeatVerdict,
} from "../../shared/native-voice-camera";
import { getMainLogger } from "../log";
import { classifyVoiceCamera, clefRequestsInFlight, judgeVoiceCameraRepeat } from "../native-voice/clef-camera";
import { SystemOneRejected, type SystemOneTarget } from "../decision/system-one";
import { decisionCameraCueAvailability } from "@pwragent/shared";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
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

const cameraLog = getMainLogger("pwragent:voice-camera");
const sessions = new NativeVoiceSessionManager((threadId) => getDesktopBackendRegistry().acquireNativeVoiceBackend(threadId));
// Cold model loading can take a minute or more. Opt-out still aborts immediately.
const CAMERA_WARMUP_TIMEOUT_MS = 5 * 60_000;
const CAMERA_ANALYSIS_TIMEOUT_MS = 8000;
// Polling Clef's /health sends nothing to the model, so a contended camera
// can look again soon.
const CAMERA_HEALTH_RETRY_MS = 1000;
const cameraRequests = new Map<number, { sessionId: string; abort: AbortController }>();
const cameraReadySessions = new Map<number, string>();
/** Owners whose last frame missed its deadline; their next frame asks Clef first. */
const cameraContended = new Set<number>();
/** The local decision server's key, read once when the owner turns the camera on. */
const cameraApiKeys = new Map<number, string | undefined>();
/** Settings decide where frames go; read per frame, since it is an in-memory lookup. */
function cameraCueAvailability() {
  return decisionCameraCueAvailability(getDesktopSettingsService().resolveDecisionModelSettings());
}
function abortCamera(owner: number, sessionId?: string): void {
  if (sessionId === undefined || cameraReadySessions.get(owner) === sessionId) {
    cameraReadySessions.delete(owner);
    cameraContended.delete(owner);
    cameraApiKeys.delete(owner);
  }
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
/** A decision request the server refused outright stops camera cues: sending it again cannot succeed. */
function cameraRefusal(error: SystemOneRejected): Error {
  const reason = error.status === 401 || error.status === 403
    ? "the local decision model refused its API key"
    : `the local decision model rejected the request${error.detail ? ` (${error.detail})` : ""}`;
  return new Error(`Camera cues stopped: ${reason}. Check it in Settings → AI Providers.`, { cause: error });
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
    const availability = cameraCueAvailability();
    const camera = availability.available ? { available: true } : { available: false, reason: availability.reason };
    try { return { ...await getDesktopBackendRegistry().nativeVoiceCapability(), camera }; }
    catch { return { available: false, reason: "Connect and sign in to Codex before starting voice.", camera }; }
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
    if (request.enabled) {
      const availability = cameraCueAvailability();
      if (!availability.available) throw new Error(availability.reason);
      cameraApiKeys.set(event.sender.id, await getDesktopSettingsService().resolveDecisionApiKey("local"));
    }
    sessions.setCamera(event.sender.id, request.sessionId, request.enabled);
    if (!request.enabled) abortCamera(event.sender.id, request.sessionId);
  });
  ipcMain.handle(NATIVE_VOICE_CAMERA_CUE_CHANNEL, async (event, request: VoiceCameraCue) => {
    validTarget(request);
    if (!isCameraCue(request.cue)) throw new Error("Invalid camera cue.");
    await sessions.cameraCue(event.sender.id, request);
  });
  ipcMain.handle(NATIVE_VOICE_CAMERA_FRAME_CHANNEL, async (event, request: VoiceCameraFrame) => {
    validTarget(request);
    if (!sessions.allowsCameraSession(event.sender.id, request.sessionId) || !sessions.allowsCamera(event.sender.id)) {
      throw new Error("Enable the camera in this voice session first.");
    }
    if (!Array.isArray(request.images) || request.images.length < 1 || request.images.length > VOICE_CAMERA_BURST.frames
      || !request.images.every((image) => typeof image === "string" && image.length <= 300_000
        && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(image))) throw new Error("Invalid camera frame.");
    if (cameraRequests.has(event.sender.id)) throw new Error("A camera frame is already being analyzed.");
    // Settings can change mid-session: turning cues off, or choosing a hosted
    // model, stops frames from going anywhere.
    const availability = cameraCueAvailability();
    if (!availability.available) throw new Error(availability.reason);
    const target: SystemOneTarget = {
      endpoint: availability.endpoint,
      model: availability.model,
      apiKey: cameraApiKeys.get(event.sender.id),
    };
    const abort = new AbortController();
    const pending = { sessionId: request.sessionId, abort };
    cameraRequests.set(event.sender.id, pending);
    const warming = cameraReadySessions.get(event.sender.id) !== request.sessionId;
    if (warming) cameraLog.info("camera first decision waiting", { sessionId: request.sessionId });
    const started = Date.now();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, warming ? CAMERA_WARMUP_TIMEOUT_MS : CAMERA_ANALYSIS_TIMEOUT_MS);
    try {
      // After a missed deadline, Clef is still running that abandoned request
      // (or another client's). Sending more only lengthens its queue.
      if (!warming && cameraContended.has(event.sender.id)) {
        const inFlight = await clefRequestsInFlight(target, abort.signal);
        if (inFlight !== undefined && inFlight > 0) {
          return { skipped: "busy", inFlight, retryAfterMs: CAMERA_HEALTH_RETRY_MS } satisfies VoiceCameraSkipped;
        }
      }
      const observation = await classifyVoiceCamera(target, request.images, abort.signal, warming);
      cameraContended.delete(event.sender.id);
      if (abort.signal.aborted || !sessions.allowsCameraSession(event.sender.id, request.sessionId) || !sessions.allowsCamera(event.sender.id)) return undefined;
      if (warming) cameraLog.info("camera first decision received", { sessionId: request.sessionId, elapsedMs: Date.now() - started, modelLatencyMs: observation.latencyMs });
      if (!abort.signal.aborted && sessions.allowsCameraSession(event.sender.id, request.sessionId)) {
        cameraReadySessions.set(event.sender.id, request.sessionId);
      }
      return observation;
    }
    catch (error) {
      if (abort.signal.aborted && !timedOut) {
        cameraLog.info("camera analysis cancelled", { sessionId: request.sessionId, warming });
        return undefined;
      }
      cameraLog.warn("camera analysis failed", { sessionId: request.sessionId, warming, timedOut, elapsedMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      // A refused request fails the same way every time, so stop rather than retry.
      if (error instanceof SystemOneRejected) throw cameraRefusal(error);
      // Once Clef has answered, a failure skips this frame, not the camera. A
      // warm model that answers slowly is usually busy with another client
      // (it serializes requests); one that refuses may be restarting.
      if (!warming) {
        if (timedOut) cameraContended.add(event.sender.id);
        return { skipped: timedOut ? "busy" : "offline" } satisfies VoiceCameraSkipped;
      }
      const message = timedOut
        ? "Clef did not respond within five minutes. Camera cues stopped; voice is still available."
        : `Camera cues unavailable. Check that the local decision model is running at ${availability.endpoint}.`;
      throw new Error(message, { cause: error });
    }
    finally {
      clearTimeout(timeout);
      if (cameraRequests.get(event.sender.id) === pending) cameraRequests.delete(event.sender.id);
    }
  });
  ipcMain.handle(NATIVE_VOICE_CAMERA_REPEAT_CHANNEL, async (event, request: VoiceCameraRepeatCheck): Promise<VoiceCameraRepeatVerdict | VoiceCameraSkipped | undefined> => {
    validTarget(request);
    if (!sessions.allowsCameraSession(event.sender.id, request.sessionId) || !sessions.allowsCamera(event.sender.id)) {
      throw new Error("Enable the camera in this voice session first.");
    }
    if (!isCameraConversation(request.conversation)) throw new Error("Invalid camera conversation.");
    // Shares the frame's single-flight slot: the check is asked between frames.
    if (cameraRequests.has(event.sender.id)) throw new Error("A camera frame is already being analyzed.");
    // The same Settings gate and target as a frame: the conversation goes
    // only to the local decision model.
    const availability = cameraCueAvailability();
    if (!availability.available) throw new Error(availability.reason);
    const target: SystemOneTarget = {
      endpoint: availability.endpoint,
      model: availability.model,
      apiKey: cameraApiKeys.get(event.sender.id),
    };
    const abort = new AbortController();
    const pending = { sessionId: request.sessionId, abort };
    cameraRequests.set(event.sender.id, pending);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, CAMERA_ANALYSIS_TIMEOUT_MS);
    try {
      // The check is an extra request on top of the frames, so it never
      // queues behind a running decision: /health answers without the model
      // lock, and a server without that route is asked anyway.
      const inFlight = await clefRequestsInFlight(target, abort.signal);
      if (inFlight !== undefined && inFlight > 0) {
        return { skipped: "busy", inFlight, retryAfterMs: CAMERA_HEALTH_RETRY_MS } satisfies VoiceCameraSkipped;
      }
      const verdict = await judgeVoiceCameraRepeat(target, request.conversation, abort.signal);
      cameraContended.delete(event.sender.id);
      if (abort.signal.aborted || !sessions.allowsCameraSession(event.sender.id, request.sessionId) || !sessions.allowsCamera(event.sender.id)) return undefined;
      return verdict;
    } catch (error) {
      if (abort.signal.aborted && !timedOut) return undefined;
      // The conversation is the operator's words: never log it.
      cameraLog.warn("camera repeat check failed", { sessionId: request.sessionId, timedOut, error: error instanceof Error ? error.message : String(error) });
      // Refused like a frame: the camera stops instead of retrying.
      if (error instanceof SystemOneRejected) throw cameraRefusal(error);
      if (timedOut) cameraContended.add(event.sender.id);
      return { skipped: timedOut ? "busy" : "offline" } satisfies VoiceCameraSkipped;
    } finally {
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
