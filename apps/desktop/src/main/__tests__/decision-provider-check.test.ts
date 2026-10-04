import { describe, expect, it, vi } from "vitest";
import { checkDecisionProvider } from "../decision/decision-provider-check";

const reply = (status: number, body: unknown = {}) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, body: { cancel: async () => {} } }) as unknown as Response;

describe("decision provider check", () => {
  it("reads the local server's health, with its load, and never runs a decision", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => reply(200, { status: "ready", requests_processing: 1, completed_decisions: 4500 }));
    await expect(checkDecisionProvider("local", { settings: { local: { endpoint: "http://localhost:9911" } }, apiKey: "sample-key", fetch }))
      .resolves.toEqual({ ok: true, detail: "Ready · 4500 decisions served · 1 in flight." });
    expect(fetch).toHaveBeenCalledExactlyOnceWith("http://localhost:9911/health", expect.objectContaining({
      headers: { Authorization: "Bearer sample-key" }, redirect: "error",
    }));
  });

  it("tells a server without /health, a refused key, and nothing listening apart", async () => {
    const settings = {};
    await expect(checkDecisionProvider("local", { settings, fetch: vi.fn(async () => reply(404)) }))
      .resolves.toMatchObject({ ok: true, detail: expect.stringContaining("no health route") });
    await expect(checkDecisionProvider("local", { settings, fetch: vi.fn(async () => reply(401)) }))
      .resolves.toEqual({ ok: false, detail: "The server refused the API key." });
    await expect(checkDecisionProvider("local", { settings, fetch: vi.fn(async () => { throw new TypeError("fetch failed"); }) }))
      .resolves.toEqual({ ok: false, detail: "Nothing answered at http://127.0.0.1:8787." });
  });

  it("asks Jev one yes/no question with the saved model and key", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => reply(200, { model: "jev-1.13.0", answers: { check: { type: "noul", noul: 0.9 } } }));
    await expect(checkDecisionProvider("jev", { settings: { jev: { model: "jev-preview" } }, apiKey: "sample-key", fetch }))
      .resolves.toEqual({ ok: true, detail: "Answered with jev-1.13.0." });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init?.headers).toEqual({ Authorization: "Bearer sample-key", "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "jev-preview", questions: { check: { type: "noul" } } });
  });

  it("needs a key before calling Jev, and names each documented failure", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(checkDecisionProvider("jev", { settings: {}, fetch })).resolves.toEqual({ ok: false, detail: "Add a TypeSafe API key first." });
    expect(fetch).not.toHaveBeenCalled();
    const status = async (code: number) => (await checkDecisionProvider("jev", { settings: {}, apiKey: "sample-key", fetch: vi.fn(async () => reply(code)) })).detail;
    await expect(status(401)).resolves.toBe("TypeSafe rejected the API key.");
    await expect(status(422)).resolves.toContain("jev-latest");
    await expect(status(529)).resolves.toContain("overloaded");
    await expect(status(500)).resolves.toBe("TypeSafe returned HTTP 500.");
  });
});
