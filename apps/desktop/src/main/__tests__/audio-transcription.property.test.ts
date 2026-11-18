import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { AudioDictationSession } from "../audio-transcription";

class SocketFixture extends EventTarget {
  static OPEN = 1;
  static last: SocketFixture;
  static connection: { url: string; options: WebSocketInit };
  readyState = 1;
  bufferedAmount = 0;
  sent: unknown[] = [];

  constructor(url: string, options: WebSocketInit) {
    super();
    SocketFixture.last = this;
    SocketFixture.connection = { url, options };
  }

  send(value: string): void {
    this.sent.push(JSON.parse(value));
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }

  receive(event: object): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
}

afterEach(() => vi.unstubAllGlobals());

it("commits once and resolves only the corresponding transcript after an arbitrary stream of deltas", async () => {
  vi.stubGlobal("WebSocket", SocketFixture);
  await fc.assert(fc.asyncProperty(
    fc.array(fc.uint8Array({ minLength: 40, maxLength: 40 }), { minLength: 1, maxLength: 20 }),
    fc.array(fc.string({ maxLength: 20 }), { maxLength: 20 }),
    fc.string({ minLength: 1, maxLength: 80 }),
    async (audio, deltas, transcript) => {
      const onDelta = vi.fn();
      const onClose = vi.fn();
      const session = new AudioDictationSession("fixture-key", { delta: onDelta, close: onClose });
      const socket = SocketFixture.last;
      try {
        socket.dispatchEvent(new Event("open"));
        expect(SocketFixture.connection).toEqual({
          url: "wss://api.openai.com/v1/realtime?intent=transcription",
          options: { headers: { Authorization: "Bearer fixture-key" } },
        });
        socket.receive({ type: "session.updated", session: { type: "transcription" } });
        await session.waitUntilReady();
        const first = new Uint8Array(4_800);
        session.append(first);
        for (const pcm of audio) session.append(pcm);
        for (const delta of deltas) {
          socket.receive({ type: "conversation.item.input_audio_transcription.delta", item_id: "expected", delta });
        }
        const result = session.finish();
        const duplicate = session.finish();
        socket.receive({ type: "input_audio_buffer.committed", item_id: "expected" });
        socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "old", transcript: "Wrong item" });
        expect(onClose).not.toHaveBeenCalled();
        socket.receive({ type: "conversation.item.input_audio_transcription.completed", item_id: "expected", transcript });
        expect(await result).toBe(transcript.trim());
        expect(await duplicate).toBe(transcript.trim());
        expect(onDelta.mock.calls.flat()).toEqual(deltas);
        expect(socket.sent).toEqual([
          { type: "session.update", session: {
            type: "transcription",
            audio: { input: { format: { type: "audio/pcm", rate: 24000 }, transcription: { model: "gpt-live-transcribe" }, turn_detection: null } },
          } },
          ...[first, ...audio].map((pcm) => ({
            type: "input_audio_buffer.append", audio: Buffer.from(pcm).toString("base64"),
          })),
          { type: "input_audio_buffer.commit" },
        ]);
      } finally {
        session.close();
      }
    },
  ));
});

it("settles startup and finish when canceled before the socket opens", async () => {
  vi.stubGlobal("WebSocket", SocketFixture);
  const session = new AudioDictationSession("fixture-key", { delta: vi.fn(), close: vi.fn() });
  session.close();
  await expect(session.waitUntilReady()).rejects.toThrow("Dictation ended.");
  await expect(session.finish()).resolves.toBe("");
  expect(SocketFixture.last.sent).toEqual([]);
});
