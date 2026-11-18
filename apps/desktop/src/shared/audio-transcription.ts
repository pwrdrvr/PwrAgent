export const TRANSCRIBE_AUDIO_FILE_CHANNEL = "audio-transcription:transcribe-file";
export const AUDIO_TRANSCRIPTION_MODEL = "gpt-transcribe";
export const AUDIO_TRANSCRIPTION_MAX_BYTES = 25_000_000;
export const AUDIO_TRANSCRIPTION_PRICE = "$0.0045 per minute ($0.27 per hour)";

export type AudioTranscriptionResult =
  | { kind: "canceled" }
  | { kind: "transcribed"; text: string }
  | { kind: "error"; message: string };
