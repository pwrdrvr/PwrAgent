import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { transcribeAudioFile } from "../audio-transcription";

afterEach(() => vi.unstubAllGlobals());

it("only uploads a nonempty, supported file at or below the byte limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "pwragent-audio-test-"));
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ text: "  A synthetic transcript.  " }));
  vi.stubGlobal("fetch", fetch);
  try {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom("wav", "MP3", "m4a", "pdf"),
      fc.oneof(fc.constantFrom(0, 25_000_000, 25_000_001), fc.integer({ min: 1, max: 2048 })),
      async (extension, size) => {
        const path = join(root, `private-filename.${extension}`);
        await writeFile(path, "");
        await truncate(path, size);
        fetch.mockClear();
        const result = await transcribeAudioFile(path, "fixture-api-key", new AbortController().signal);

        const shouldUpload = extension !== "pdf" && size > 0 && size <= 25_000_000;
        expect(fetch).toHaveBeenCalledTimes(shouldUpload ? 1 : 0);
        if (!shouldUpload) {
          expect(result.kind).toBe("error");
          return;
        }
        const [url, request] = fetch.mock.calls[0]!;
        expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
        expect(request).toMatchObject({
          method: "POST",
          redirect: "error",
          headers: { Authorization: "Bearer fixture-api-key" },
        });
        const form = request?.body as FormData;
        expect(form.get("model")).toBe("gpt-transcribe");
        expect(form.get("file")).toMatchObject({ name: `recording.${extension.toLowerCase()}`, size });
        expect(result).toEqual({ kind: "transcribed", text: "A synthetic transcript." });
      },
    ), {
      numRuns: 32,
      examples: [["wav", 0], ["wav", 25_000_000], ["wav", 25_000_001], ["pdf", 1]],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
