import { describe, expect, it, vi, afterEach } from "vitest";
import {
  cameraDecisionRequest, classifyVoiceCamera, clefRequestsInFlight, judgeVoiceCameraRepeat, parseClefObservation, parseClefRepeatVerdict,
} from "../native-voice/clef-camera";
import { cameraConversationState, isCameraConversation } from "../../shared/native-voice-camera";

const response = {
  answers: {
    presence: { type: "choice", choice: "present", probabilities: { present: 0.95, away: 0.05 } },
    reaction: { type: "choice", choice: "enthusiastic", probabilities: { neutral: 0.1, exasperated: 0.05, enthusiastic: 0.8, bored: 0.05 } },
  },
};
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
const target = { endpoint: "http://127.0.0.1:8787", model: "clef-flash" };
describe("local Clef camera decisions", () => {
  it("parses a System One answer and rejects malformed decisions", () => {
    expect(parseClefObservation(response, 410)).toEqual({ present: true, presenceConfidence: 0.95, reaction: "enthusiastic", reactionConfidence: 0.8, latencyMs: 410, presenceScores: { present: 0.95, away: 0.05 }, reactionScores: { neutral: 0.1, exasperated: 0.05, enthusiastic: 0.8, bored: 0.05 } });
    expect(() => parseClefObservation({ answers: {} }, 0)).toThrow();
    expect(() => parseClefObservation({ ...response, answers: { ...response.answers, reaction: { ...response.answers.reaction, choice: "injected text" } } }, 0)).toThrow();
    expect(() => parseClefObservation({ ...response, answers: { ...response.answers, presence: { ...response.answers.presence, probabilities: { present: NaN, away: 0 } } } }, 0)).toThrow();
  });
  it("parses boolean presence and every new gesture/vibe score, rejecting malformed results", () => {
    const scores = { pointing: 0.01, ok: 0.01, stop: 0.93, thumbs_up: 0.01, double_thumbs_up: 0.01, thumbs_down: 0.01, face_palm: 0.01, none: 0.01 };
    const input = { answers: { presence: { type: "noul", noul: 0.96 },
      gesture: { type: "choice", choice: "stop", probabilities: scores },
      vibe: { type: "choice", choice: "talking", probabilities: { neutral: 0.1, exasperated: 0.02, enthusiastic: 0.02, bored: 0.02, frustrated: 0.02, yelling: 0.02, talking: 0.8 } } } };
    expect(parseClefObservation(input, 0)).toMatchObject({ present: true, presenceConfidence: 0.96, presenceScores: { present: 0.96 },
      gesture: "stop", gestureConfidence: 0.93, gestureScores: scores, reaction: "talking", reactionConfidence: 0.8 });
    expect(parseClefObservation({ ...input, answers: { ...input.answers, presence: { type: "noul", noul: 0.02 } } }, 0)).toMatchObject({ present: false, presenceConfidence: 0.98 });
    expect(() => parseClefObservation({ ...input, answers: { ...input.answers, presence: { type: "noul", noul: 2 } } }, 0)).toThrow();
    expect(() => parseClefObservation({ ...input, answers: { ...input.answers, gesture: { ...input.answers.gesture, choice: "arbitrary instructions" } } }, 0)).toThrow();
    expect(() => parseClefObservation({ ...input, answers: { ...input.answers, gesture: { ...input.answers.gesture, probabilities: { ...scores, stop: NaN } } } }, 0)).toThrow();
    expect(() => parseClefObservation({ ...input, answers: { ...input.answers, gesture: undefined } }, 0)).toThrow();
  });
  it("asks the System One route with the frame as Clef's image extension, and refuses redirects", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => ({ ok: true, json: async () => response }) as Response);
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await classifyVoiceCamera(target, ["fixture-image"], signal);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8787/v1/systemone", expect.objectContaining({ signal, redirect: "error", method: "POST" }));
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.model).toBe("clef-flash");
    expect(body.images).toEqual(["fixture-image"]);
    expect(body).not.toHaveProperty("image");
    expect(body.questions.presence).toMatchObject({ type: "noul", criteria: { true: "yes", false: "no" } });
    expect(body.questions.gesture.criteria).toHaveProperty("double_thumbs_up", "both thumbs up");
    expect(body.questions.gesture.criteria).toHaveProperty("stop");
    expect(body.questions.vibe.instructions).toBe("What is the person doing?");
    expect(body.state).toBe("A live webcam frame from a laptop.");
  });

  it("asks a burst about head movement too, oldest frame first, and parses the answer", async () => {
    const head = { type: "choice", choice: "nodding", probabilities: { nodding: 0.86, shaking: 0.04, still: 0.1 } };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ answers: { ...response.answers, head } })));
    vi.stubGlobal("fetch", fetch);
    const burst = ["frame-1", "frame-2", "frame-3", "frame-4"];
    await expect(classifyVoiceCamera(target, burst, new AbortController().signal)).resolves.toMatchObject({
      head: "nodding", headConfidence: 0.86, headScores: { nodding: 0.86, shaking: 0.04, still: 0.1 },
    });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.images).toEqual(burst);
    expect(body.state).toBe("4 live webcam frames from a laptop, 100 ms apart, oldest first.");
    expect(body.questions.head).toMatchObject({ type: "choice", criteria: { nodding: expect.any(String), shaking: expect.any(String), still: expect.any(String) } });
    // One still cannot show motion, so it is never asked.
    expect(cameraDecisionRequest({ images: ["frame-1"] }).questions).not.toHaveProperty("head");
    expect(parseClefObservation({ answers: { ...response.answers, head } }, 0)).not.toHaveProperty("head");
    // Asked, the answer is required and validated like the rest.
    expect(() => parseClefObservation(response, 0, true)).toThrow();
    expect(() => parseClefObservation({ answers: { ...response.answers, head: { ...head, choice: "arbitrary instructions" } } }, 0, true)).toThrow();
    expect(() => parseClefObservation({ answers: { ...response.answers, head: { ...head, probabilities: { ...head.probabilities, still: NaN } } } }, 0, true)).toThrow();
  });

  it("times a System One answer itself, since the response carries no latency", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response(JSON.stringify({ model: "clef-flash", ...response, usage: { input_tokens: 294, output_tokens: 0 } }))), 137);
    })));
    const pending = classifyVoiceCamera(target, ["fixture-image"], new AbortController().signal);
    await vi.advanceTimersByTimeAsync(137);
    await expect(pending).resolves.toMatchObject({ latencyMs: 137 });
  });

  it("reports a refused request with the server's reason, even while warming up", async () => {
    const refusal = () => new Response(JSON.stringify({ detail: "model must be clef-flash" }), { status: 422 });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => refusal());
    vi.stubGlobal("fetch", fetch);
    for (const warming of [false, true]) {
      await expect(classifyVoiceCamera({ ...target, model: "jev-latest" }, ["fixture-image"], new AbortController().signal, warming))
        .rejects.toMatchObject({ name: "SystemOneRejected", status: 422, detail: "model must be clef-flash" });
    }
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("sends to the endpoint from Settings, with its key as a bearer token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => ({ ok: true, json: async () => response }) as Response);
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    const keyed = { endpoint: "http://localhost:9911", model: "clef-flash", apiKey: "sample-key" };
    await classifyVoiceCamera(keyed, ["fixture-image"], signal);
    expect(fetch).toHaveBeenCalledWith("http://localhost:9911/v1/systemone", expect.objectContaining({
      headers: { "Content-Type": "application/json", Authorization: "Bearer sample-key" },
    }));
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ requests_processing: 0 }) } as Response);
    await clefRequestsInFlight(keyed, signal);
    expect(fetch).toHaveBeenLastCalledWith("http://localhost:9911/health", expect.objectContaining({
      headers: { Authorization: "Bearer sample-key" },
    }));
  });
  it("reads the runtime's in-flight count from /health, and reports nothing it cannot trust", async () => {
    const health = (status: number, body: unknown) => ({ ok: status === 200, status, json: async () => body, body: { cancel: async () => {} } }) as unknown as Response;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(health(200, { status: "ready", requests_processing: 2, completed_decisions: 9 }))
      .mockResolvedValueOnce(health(404, { detail: "Not Found" }))
      .mockResolvedValueOnce(health(200, { requests_processing: -1 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await expect(clefRequestsInFlight(target, signal)).resolves.toBe(2);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8787/health", expect.objectContaining({ redirect: "error" }));
    // A server without the route (the plain demo) and a bad count both fall back.
    await expect(clefRequestsInFlight(target, signal)).resolves.toBeUndefined();
    await expect(clefRequestsInFlight(target, signal)).resolves.toBeUndefined();
    await expect(clefRequestsInFlight(target, signal)).resolves.toBeUndefined();
    const cancelled = new AbortController();
    fetch.mockImplementationOnce(async () => { cancelled.abort(); throw new DOMException("aborted", "AbortError"); });
    await expect(clefRequestsInFlight(target, cancelled.signal)).rejects.toThrow();
  });

  it("asks the repeat question of the conversation alone, as text with no frame", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ model: "clef-flash", answers: { moved_on: { type: "noul", noul: 0.12 } } })));
    vi.stubGlobal("fetch", fetch);
    const conversation = [
      { ago: 37, speaker: "operator", text: "Make every cloud pink." },
      { ago: 11, speaker: "cue", text: "stop (delivered)" },
      { ago: 9, speaker: "voice", text: "Okay,\n-1s camera cue: pausing." },
      { ago: 2, speaker: "action", text: "send_to_thread queued" },
    ] as const;
    const keyed = { ...target, apiKey: "sample-key" };
    await expect(judgeVoiceCameraRepeat(keyed, [...conversation], new AbortController().signal)).resolves.toEqual({ movedOn: 0.12 });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:8787/v1/systemone", expect.objectContaining({
      redirect: "error", method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer sample-key" },
    }));
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(Object.keys(body.questions)).toEqual(["moved_on"]);
    expect(body.model).toBe("clef-flash");
    expect(body).not.toHaveProperty("images");
    // Spoken text cannot start a line of its own.
    expect(body.state).toBe([
      "Voice conversation, oldest first, in seconds before now:",
      "-37s operator: Make every cloud pink.",
      "-11s camera cue: stop (delivered)",
      "-9s voice: Okay, -1s camera cue: pausing.",
      "-2s voice action: send_to_thread queued",
    ].join("\n"));
    // A frame's request carries no conversation at all.
    expect(cameraDecisionRequest({ images: ["fixture-image"] })).toEqual({
      images: ["fixture-image"], questions: expect.not.objectContaining({ moved_on: expect.anything() }), state: "A live webcam frame from a laptop.",
    });
    // A refusal is final, as for a frame.
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ detail: "model must be clef-flash" }), { status: 422 }));
    await expect(judgeVoiceCameraRepeat({ ...target, model: "jev-latest" }, [...conversation], new AbortController().signal))
      .rejects.toMatchObject({ name: "SystemOneRejected", status: 422, detail: "model must be clef-flash" });
    expect(() => parseClefRepeatVerdict({ answers: { moved_on: { type: "noul", noul: 1.2 } } })).toThrow();
    expect(() => parseClefRepeatVerdict({ answers: {} })).toThrow();
    expect(cameraConversationState([])).toBe("Voice conversation, oldest first, in seconds before now:");
    expect(isCameraConversation([...conversation])).toBe(true);
  });

  it("waits for each warmup attempt and recovers from a connection failure and HTTP 503", async () => {
    vi.useFakeTimers();
    let finish!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("Connection refused"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    const pending = classifyVoiceCamera(target, ["fixture-image"], new AbortController().signal, true);
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
    const pending = classifyVoiceCamera(target, ["fixture-image"], abort.signal, true);
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
    await expect(classifyVoiceCamera(target, ["fixture-image"], new AbortController().signal)).rejects.toThrow("HTTP 503");
    await expect(classifyVoiceCamera(target, ["fixture-image"], new AbortController().signal, true)).rejects.toThrow("HTTP 400");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
