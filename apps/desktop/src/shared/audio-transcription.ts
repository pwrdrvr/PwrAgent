export const DICTATION_START_CHANNEL = "dictation:start";
export const DICTATION_AUDIO_CHANNEL = "dictation:audio";
export const DICTATION_FINISH_CHANNEL = "dictation:finish";
export const DICTATION_CANCEL_CHANNEL = "dictation:cancel";
export const DICTATION_EVENT_CHANNEL = "dictation:event";
export const DICTATION_RATE = 24_000;
export const DICTATION_BATCH_SAMPLES = 2_400;
export const DICTATION_PRICE = "$0.017 per minute ($1.02 per hour)";

export type DictationEvent = { id: string } & (
  // The provider connection is open, so the microphone may start while the
  // transcription session is still being configured.
  | { kind: "connecting" }
  | { kind: "delta"; text: string }
  | { kind: "error"; message: string }
);
export type DictationApi = {
  start: (id: string) => Promise<void>;
  audio: (id: string, pcm: Uint8Array) => Promise<void>;
  finish: (id: string) => Promise<string>;
  cancel: (id: string) => Promise<void>;
  onEvent: (listener: (event: DictationEvent) => void) => () => void;
};
