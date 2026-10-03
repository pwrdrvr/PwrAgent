import { describe, expect, it, vi, afterEach } from "vitest";
import { classifyVoiceCamera, parseClefObservation } from "../native-voice/clef-camera";

const response = {
  answers: {
    presence: { type: "choice", choice: "present", probabilities: { present: 0.95, away: 0.05 } },
    reaction: { type: "choice", choice: "enthusiastic", probabilities: { neutral: 0.1, exasperated: 0.05, enthusiastic: 0.8, bored: 0.05 } },
  },
  latency_ms: 410,
};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("local Clef camera decisions", () => {
  it("parses the clef-webcam response and rejects malformed decisions", () => {
    expect(parseClefObservation(response)).toEqual({ present: true, presenceConfidence: 0.95, reaction: "enthusiastic", reactionConfidence: 0.8, latencyMs: 410 });
    expect(() => parseClefObservation({ answers: {} })).toThrow();
    expect(() => parseClefObservation({ ...response, answers: { ...response.answers, reaction: { ...response.answers.reaction, choice: "injected text" } } })).toThrow();
    expect(() => parseClefObservation({ ...response, answers: { ...response.answers, presence: { ...response.answers.presence, probabilities: { present: NaN, away: 0 } } } })).toThrow();
  });
  it("posts only to the fixed loopback endpoint and refuses redirects", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => ({ ok: true, json: async () => response }) as Response);
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await classifyVoiceCamera("fixture-image", signal);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8787/decide", expect.objectContaining({ signal, redirect: "error", method: "POST" }));
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.questions.presence.criteria).toEqual({ present: "person visible", away: "no person visible" });
    expect(body.image).toBe("fixture-image");
  });

  it("waits for each warmup attempt and recovers from a connection failure and HTTP 503", async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("Connection refused"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const pending = classifyVoiceCamera("fixture-image", new AbortController().signal, true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(fetch).toHaveBeenCalledTimes(3);
    finish(new Response(JSON.stringify(response)));
    await expect(pending).resolves.toMatchObject({ reaction: "enthusiastic" });
  });

  it("cancels warmup backoff immediately without starting another request", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("Connection refused"));
    vi.stubGlobal("fetch", fetch);
    const abort = new AbortController();
    const pending = classifyVoiceCamera("fixture-image", abort.signal, true);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry normal inference failures or invalid warmup requests", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    await expect(classifyVoiceCamera("fixture-image", new AbortController().signal)).rejects.toThrow("HTTP 503");
    await expect(classifyVoiceCamera("fixture-image", new AbortController().signal, true)).rejects.toThrow("HTTP 400");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
