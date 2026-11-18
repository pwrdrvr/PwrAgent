import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname } from "node:path";
import {
  AUDIO_TRANSCRIPTION_MAX_BYTES,
  AUDIO_TRANSCRIPTION_MODEL,
  type AudioTranscriptionResult,
} from "../shared/audio-transcription";

export const OPENAI_TRANSCRIPTION_URL = "https://api.openai.com/v1/audio/transcriptions";
const TRANSCRIPTION_TIMEOUT_MS = 5 * 60_000;
const AUDIO_TYPES = new Map([
  ["flac", "audio/flac"],
  ["mp3", "audio/mpeg"],
  ["mp4", "audio/mp4"],
  ["mpeg", "audio/mpeg"],
  ["mpga", "audio/mpeg"],
  ["m4a", "audio/mp4"],
  ["ogg", "audio/ogg"],
  ["wav", "audio/wav"],
  ["webm", "audio/webm"],
]);
export const AUDIO_TRANSCRIPTION_EXTENSIONS = [...AUDIO_TYPES.keys()];

type Recording = { bytes: Uint8Array<ArrayBuffer>; extension: string; mimeType: string };
type TranscriptionError = Extract<AudioTranscriptionResult, { kind: "error" }>;

function failure(message: string): TranscriptionError {
  return { kind: "error", message };
}

async function readRecording(path: string): Promise<Recording | TranscriptionError> {
  const extension = extname(path).slice(1).toLowerCase();
  const mimeType = AUDIO_TYPES.get(extension);
  if (!mimeType) {
    return failure("Choose a supported audio file (FLAC, MP3, MP4, MPEG, MPGA, M4A, OGG, WAV, or WebM).");
  }

  // Inspect and read the same handle. A growing file cannot overrun the cap,
  // and a special file such as a FIFO must not block while opening.
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const details = await file.stat();
      const { size, mtimeMs } = details;
      if (size > AUDIO_TRANSCRIPTION_MAX_BYTES) {
        return failure("Choose an audio file of 25 MB or less.");
      }
      if (!details.isFile() || size === 0) {
        return failure("Choose a nonempty audio file.");
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const { bytesRead } = await file.read(bytes, offset, size - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const current = await file.stat();
      if (offset !== size || current.size !== size || current.mtimeMs !== mtimeMs) {
        return failure("The audio file changed while it was being read. Choose it again.");
      }
      return { bytes, extension, mimeType };
    } finally {
      await file.close();
    }
  } catch {
    return failure("PwrAgent could not read the selected audio file.");
  }
}

export async function transcribeAudioFile(
  path: string,
  apiKey: string,
  ownerSignal: AbortSignal,
): Promise<AudioTranscriptionResult> {
  const recording = await readRecording(path);
  if ("kind" in recording) return recording;
  if (ownerSignal.aborted) return { kind: "canceled" };

  const form = new FormData();
  form.set("model", AUDIO_TRANSCRIPTION_MODEL);
  form.set("response_format", "json");
  // The provider only needs the container extension, not the user's filename.
  form.set("file", new Blob([recording.bytes], { type: recording.mimeType }), `recording.${recording.extension}`);
  const timeout = AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS);
  try {
    const response = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      redirect: "error",
      signal: AbortSignal.any([ownerSignal, timeout]),
    });
    if (!response.ok) {
      // Provider error bodies can contain request data. Expose only the status.
      await response.body?.cancel().catch(() => undefined);
      switch (response.status) {
        case 401:
        case 403:
          return failure("OpenAI refused the transcription API key. Check the key and project permissions in Settings.");
        case 413:
          return failure("OpenAI rejected the audio file size. Choose a smaller file.");
        case 429:
          return failure("OpenAI limited the request. Check your API project's billing and usage limits.");
        case 400:
        case 422:
          return failure("OpenAI could not read the recording. Check the audio format and try another file.");
        default:
          return failure(`OpenAI transcription failed (HTTP ${response.status}).`);
      }
    }
    const body: unknown = await response.json();
    const text = body && typeof body === "object" && "text" in body && typeof body.text === "string"
      ? body.text.trim()
      : undefined;
    if (text === undefined) return failure("OpenAI returned an invalid transcription response.");
    return text ? { kind: "transcribed", text } : failure("OpenAI returned an empty transcript.");
  } catch {
    if (ownerSignal.aborted) return { kind: "canceled" };
    return failure(timeout.aborted
      ? "The transcription request timed out."
      : "Could not complete the transcription request to OpenAI.");
  }
}
