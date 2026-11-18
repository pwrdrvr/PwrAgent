import { BrowserWindow, dialog, ipcMain } from "electron";
import { AUDIO_TRANSCRIPTION_EXTENSIONS, transcribeAudioFile } from "../../audio-transcription";
import { getDesktopSettingsService } from "../../settings/desktop-settings-singleton";
import {
  TRANSCRIBE_AUDIO_FILE_CHANNEL,
  type AudioTranscriptionResult,
} from "../../../shared/audio-transcription";
import { isLocalMainWindowWebContents } from "../window-channels";

export function registerAudioTranscriptionIpc(): void {
  ipcMain.removeHandler(TRANSCRIBE_AUDIO_FILE_CHANNEL);
  let working = false;
  ipcMain.handle(TRANSCRIBE_AUDIO_FILE_CHANNEL, async (event): Promise<AudioTranscriptionResult> => {
    const sender = event.sender;
    if (!event.senderFrame || event.senderFrame.parent || !isLocalMainWindowWebContents(sender)) {
      return { kind: "error", message: "Audio transcription is available in a local PwrAgent window." };
    }
    const window = BrowserWindow.fromWebContents(sender);
    if (!window) return { kind: "canceled" };
    if (working) return { kind: "error", message: "Another audio transcription is in progress." };

    working = true;
    const owner = new AbortController();
    const stop = () => owner.abort();
    sender.once("destroyed", stop);
    sender.once("render-process-gone", stop);
    try {
      const apiKey = await getDesktopSettingsService().resolveOpenAITranscriptionApiKey();
      if (!apiKey) {
        return {
          kind: "error",
          message: "Add an OpenAI project API key in Settings → AI Providers → Audio transcription.",
        };
      }
      if (owner.signal.aborted) return { kind: "canceled" };
      const result = await dialog.showOpenDialog(window, {
        title: "Choose audio to send to OpenAI",
        buttonLabel: "Transcribe with OpenAI",
        properties: ["openFile"],
        filters: [{ name: "Audio recordings", extensions: AUDIO_TRANSCRIPTION_EXTENSIONS }],
      });
      const path = result.filePaths[0];
      if (result.canceled || !path || owner.signal.aborted) return { kind: "canceled" };
      return await transcribeAudioFile(path, apiKey, owner.signal);
    } catch {
      return { kind: "error", message: "PwrAgent could not start audio transcription." };
    } finally {
      sender.removeListener("destroyed", stop);
      sender.removeListener("render-process-gone", stop);
      working = false;
    }
  });
}
