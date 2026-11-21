import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import { AudioDictationSession } from "../../audio-transcription";
import { getDesktopConfigStore, getDesktopSettingsService } from "../../settings/desktop-settings-singleton";
import {
  DICTATION_AUDIO_CHANNEL,
  DICTATION_BATCH_SAMPLES,
  DICTATION_CANCEL_CHANNEL,
  DICTATION_EVENT_CHANNEL,
  DICTATION_FINISH_CHANNEL,
  DICTATION_START_CHANNEL,
  type DictationEvent,
} from "../../../shared/audio-transcription";
import { isMainWindowWebContents } from "../window-channels";

type Owner = { sender: WebContents; id: string; connection?: AudioDictationSession; detach: () => void };
const DICTATION_DISABLED = "Audio transcription is turned off in Settings → AI Providers.";
let active: Owner | undefined;

export function dictationActive(): boolean {
  return active !== undefined;
}

export function allowsDictationMicrophone(owner: number): boolean {
  // The microphone opens while the provider session is still connecting, so
  // capture is already running when the session reports ready. A connection
  // that closes releases its owner, which revokes this.
  return active?.sender.id === owner && active.connection !== undefined;
}

function findOwner(event: IpcMainInvokeEvent, id: string): Owner | undefined {
  return active?.sender === event.sender && active.id === id && event.senderFrame && !event.senderFrame.parent
    ? active
    : undefined;
}

function release(owner: Owner, error?: string): void {
  if (active !== owner) return;
  active = undefined;
  owner.detach();
  owner.connection?.close();
  if (error) publish(owner, { id: owner.id, kind: "error", message: error });
}

function publish(owner: Owner, event: DictationEvent): void {
  if (!owner.sender.isDestroyed()) owner.sender.send(DICTATION_EVENT_CHANNEL, event);
}

export function registerAudioTranscriptionIpc(voiceBusy: () => boolean): void {
  ipcMain.handle(DICTATION_START_CHANNEL, async (event, id: string) => {
    const sender = event.sender;
    if (!event.senderFrame || event.senderFrame.parent || !isMainWindowWebContents(sender)
      || typeof id !== "string" || !/^[a-z0-9-]{1,80}$/.test(id)) {
      // Dictation belongs to the viewer: this machine's microphone and key
      // fill a local draft, whichever instance owns the thread.
      throw new Error("Dictation is available in a PwrAgent composer.");
    }
    if (active || voiceBusy()) throw new Error("End the current microphone session before dictating.");
    const configStore = getDesktopConfigStore();
    if (configStore.read("models").audioTranscriptionEnabled === false) {
      throw new Error(DICTATION_DISABLED);
    }

    let unsubscribeConfig: (() => void) | undefined;
    const stop = () => release(owner);
    const onNavigation = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame) stop();
    };
    const owner: Owner = { sender, id, detach: () => {
      unsubscribeConfig?.();
      sender.removeListener("destroyed", stop);
      sender.removeListener("render-process-gone", stop);
      sender.removeListener("did-start-navigation", onNavigation);
    } };
    active = owner;
    sender.once("destroyed", stop);
    sender.once("render-process-gone", stop);
    sender.on("did-start-navigation", onNavigation);
    try {
      unsubscribeConfig = configStore.subscribe(["models"], ({ values }) => {
        if (values.models.audioTranscriptionEnabled === false) release(owner, DICTATION_DISABLED);
      });
      const key = await getDesktopSettingsService().resolveOpenAITranscriptionApiKey().catch(() => undefined);
      if (active !== owner) return;
      if (!key) throw new Error("Add an OpenAI project API key in Settings → AI Providers → Audio transcription.");
      owner.connection = new AudioDictationSession(key, {
        delta: (text) => publish(owner, { id, kind: "delta", text }),
        close: (error) => release(owner, error),
      });
      publish(owner, { id, kind: "connecting" });
      await owner.connection.waitUntilReady();
    } catch (error) {
      release(owner);
      throw error;
    }
  });
  ipcMain.handle(DICTATION_AUDIO_CHANNEL, (event, id: string, pcm: Uint8Array) => {
    if (!(pcm instanceof Uint8Array) || !pcm.byteLength || pcm.byteLength % 2
      || pcm.byteLength > DICTATION_BATCH_SAMPLES * 2) return;
    findOwner(event, id)?.connection?.append(pcm);
  });
  ipcMain.handle(DICTATION_FINISH_CHANNEL, async (event, id: string) =>
    await findOwner(event, id)?.connection?.finish() ?? "");
  ipcMain.handle(DICTATION_CANCEL_CHANNEL, (event, id: string) => {
    const owner = findOwner(event, id);
    if (owner) release(owner);
  });
}
