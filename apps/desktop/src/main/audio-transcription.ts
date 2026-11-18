import { DICTATION_RATE } from "../shared/audio-transcription";

export const OPENAI_DICTATION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const CONNECT_TIMEOUT_MS = 15_000;
const FINAL_TIMEOUT_MS = 12_000;
const MIN_PCM_BYTES = DICTATION_RATE * 2 / 10;
const MAX_SOCKET_BACKLOG = DICTATION_RATE * 2 * 4;
const SETTINGS_HINT = "Check the OpenAI project key and Realtime access in Settings → AI Providers → Audio transcription.";

type Outcome = { text: string } | { error: string };

export class AudioDictationSession {
  private readonly socket: WebSocket;
  // Resolve on every terminal path, including cancellation before a caller
  // starts awaiting the final result.
  private readonly ready = Promise.withResolvers<string | undefined>();
  private readonly final = Promise.withResolvers<Outcome>();
  private timeout: ReturnType<typeof setTimeout>;
  private state: "connecting" | "listening" | "finishing" | "closed" = "connecting";
  private bytes = 0;
  private committedItem?: string;

  constructor(apiKey: string, private readonly callbacks: {
    delta: (text: string) => void;
    close: (error?: string) => void;
  }) {
    // Electron main uses Node's WebSocket, whose constructor supports
    // request headers in addition to the browser's subprotocol argument.
    const NodeWebSocket = WebSocket as typeof WebSocket & {
      new (url: string, options: WebSocketInit): WebSocket;
    };
    try {
      this.socket = new NodeWebSocket(OPENAI_DICTATION_URL, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch {
      throw new Error(`Could not start OpenAI live transcription. ${SETTINGS_HINT}`);
    }
    this.timeout = setTimeout(() => this.close("OpenAI did not start live transcription in time."), CONNECT_TIMEOUT_MS);
    this.socket.addEventListener("open", () => {
      if (this.state !== "connecting") return;
      this.send({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: DICTATION_RATE },
              transcription: { model: "gpt-live-transcribe" },
              turn_detection: null,
            },
          },
        },
      });
    });
    this.socket.addEventListener("message", (event) => this.onMessage(event.data));
    this.socket.addEventListener("error", () => this.close(
      this.state === "connecting"
        ? `Could not connect to OpenAI live transcription. ${SETTINGS_HINT}`
        : "The OpenAI live transcription connection failed.",
    ));
    this.socket.addEventListener("close", () => this.close("The OpenAI live transcription connection closed."));
  }

  async waitUntilReady(): Promise<void> {
    const error = await this.ready.promise;
    if (error || !this.listening) throw new Error(error ?? "Dictation ended.");
  }

  get listening(): boolean {
    return this.state === "listening";
  }

  append(pcm: Uint8Array): void {
    if (!this.listening) return;
    this.bytes += pcm.byteLength;
    this.send({ type: "input_audio_buffer.append", audio: Buffer.from(pcm).toString("base64") });
  }

  async finish(): Promise<string> {
    if (this.listening) {
      if (this.bytes < MIN_PCM_BYTES) {
        this.close();
      } else {
        this.state = "finishing";
        this.timeout = setTimeout(() => this.close("OpenAI did not finalize the transcript in time."), FINAL_TIMEOUT_MS);
        this.send({ type: "input_audio_buffer.commit" });
      }
    } else if (this.state === "connecting") {
      this.close();
    }
    const result = await this.final.promise;
    if ("error" in result) throw new Error(result.error);
    return result.text;
  }

  close(error?: string, text = ""): void {
    if (this.state === "closed") return;
    const wasListening = this.listening;
    this.state = "closed";
    clearTimeout(this.timeout);
    this.ready.resolve(error);
    this.final.resolve(error ? { error } : { text });
    // Only listening failures need an asynchronous notification. Start and
    // finish already return errors to their callers.
    this.callbacks.close(wasListening ? error : undefined);
    this.socket.close();
  }

  private send(event: object): void {
    if (this.socket.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > MAX_SOCKET_BACKLOG) {
      this.close("The live transcription connection could not keep up.");
      return;
    }
    try {
      this.socket.send(JSON.stringify(event));
    } catch {
      this.close("The OpenAI live transcription connection failed.");
    }
  }

  private onMessage(raw: unknown): void {
    if (this.state === "closed" || typeof raw !== "string") return;
    let event: { type?: string; session?: { type?: string }; item_id?: string; delta?: string; transcript?: string } | null;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    switch (event?.type) {
      case "session.updated":
        if (this.state === "connecting" && event.session?.type === "transcription") {
          clearTimeout(this.timeout);
          this.state = "listening";
          this.ready.resolve(undefined);
        }
        break;
      case "conversation.item.input_audio_transcription.delta":
        if ((this.listening || this.state === "finishing") && typeof event.delta === "string") {
          this.callbacks.delta(event.delta);
        }
        break;
      case "input_audio_buffer.committed":
        if (this.state === "finishing" && typeof event.item_id === "string") this.committedItem ??= event.item_id;
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (this.committedItem && event.item_id === this.committedItem && typeof event.transcript === "string") {
          this.close(undefined, event.transcript.trim());
        }
        break;
      case "conversation.item.input_audio_transcription.failed":
      case "error":
        // OpenAI error bodies can contain request data.
        this.close(this.state === "connecting"
          ? `OpenAI refused the live transcription session. ${SETTINGS_HINT}`
          : "OpenAI could not transcribe this recording.");
        break;
    }
  }
}
