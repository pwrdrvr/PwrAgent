import { crc32, deflateSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { createHeadlessImage } from "../headless/image";
import { OpenAIDecisionsService } from "../openai-decisions/openai-decisions-service";
import type { OpenAIDecisionVersionRecord } from "../storage/openai-decision-store";

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const contents = Buffer.concat([Buffer.from(type), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(contents));
  return Buffer.concat([length, contents, checksum]);
}

function pngDataUrl(side: number): string {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8;
  const png = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc((side + 1) * side))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

const imageUrl = pngDataUrl(280);
const image = { type: "input_image", image_url: imageUrl };
const caller = { backend: "codex", threadId: "test-thread" };
const question = { type: "predicate", instructions: "Is the image dark?" };

function setup(provider: "openai" | "jev" | "local", model: string, directory?: string) {
  let stored: OpenAIDecisionVersionRecord | undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ model, answers: [] }));
  const service = new OpenAIDecisionsService({
    store: {
      insertFirstVersion: (record) => { stored = record; },
      insertNextVersion: (record) => { stored = record; },
      softDelete: vi.fn(),
      getVersion: () => stored,
      getActive: () => stored,
      findActiveByName: () => stored ? [stored] : [],
      listVisible: () => stored ? [stored] : [],
      listActiveProfile: () => stored ? [stored] : [],
      hasDeletedName: () => false,
    },
    readApiKey: async () => "test-key",
    readSystemOneTarget: async () => ({ endpoint: "http://localhost:8787", model }),
    readAccountSettings: () => ({}),
    profileId: () => "test",
    recordUsageLines: async () => undefined,
    fetch,
    resolveDefaultProvider: async () => provider,
    readProviderModel: () => model,
    decodeImage: createHeadlessImage,
    ...(directory ? { batchResultsDirectory: () => directory } : {}),
  });
  return { service, fetch };
}

describe("decision image capability", () => {
  const providers = [
    { provider: "openai", model: "gpt-6-luna", accepts: true },
    { provider: "jev", model: "jev-latest", accepts: true },
    { provider: "jev", model: "jev-1.13.0", accepts: true },
    { provider: "jev", model: "jev-1.12.0", accepts: false },
    { provider: "local", model: "clef-flash", accepts: true },
    { provider: "local", model: "other", accepts: false },
  ] as const;

  it.each(providers)("matches the documented image support of $provider/$model", async ({ provider, model, accepts }) => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("inspect", "compare"), fc.integer({ min: 1, max: 4 }), async (text, count) => {
      const { service, fetch } = setup(provider, model);
      const input = [{ type: "input_text", text }, ...Array.from({ length: count }, () => image)];
      const registration = service.register(caller, {
        name: "cat",
        question,
        inputSchema: { type: "string", "x-pwragent-images": true },
      });
      if (accepts) {
        await registration;
        expect(service.list(caller, {}).decisions[0]).toMatchObject({
          inputCapabilities: { images: { supported: true } },
        });
        await service.invoke(caller, { name: "cat", input });
        const request = fetch.mock.calls[0]?.[1];
        const body = JSON.parse(String(request?.body));
        switch (provider) {
          case "openai":
            expect(body.input[0].content).toEqual(input);
            break;
          case "local":
            expect(body).toMatchObject({ state: text, images: input.slice(1).map(() => imageUrl) });
            break;
          case "jev":
            expect(new Headers(request?.headers).get("TypeSafe-Danger-Zone-Images")).toBe("true");
            expect(body.state.input).toBe(text);
            expect(body.state.images).toHaveLength(count);
            for (const asset of body.state.images) {
              expect(body.assets[asset]).toEqual({ type: "image", format: "png", data_base64: imageUrl.split(",")[1] });
            }
            break;
        }
      } else {
        await expect(registration).rejects.toMatchObject({ code: "images_unsupported" });
        await expect(service.register(caller, {
          provider, name: "cat", question, prefix: [image], inputSchema: { type: "string" },
        })).rejects.toMatchObject({ code: "images_unsupported" });
        await expect(service.invoke(caller, { definition: { question }, input })).rejects.toMatchObject({
          code: "images_unsupported",
          message: expect.stringContaining(provider),
        });
        const batch = await service.invoke(caller, {
          definition: { question }, inputs: [text, input, text], concurrency: 1,
        });
        expect(batch).toMatchObject({ succeeded: 2, failed: 1, skipped: 0 });
        expect(batch.results).toEqual(expect.arrayContaining([
          expect.objectContaining({ index: 1, ok: false, code: "images_unsupported" }),
        ]));
        expect(fetch).toHaveBeenCalledTimes(2);
      }
    }), { numRuns: 14 });
  });

  it("enforces the count, type, dimension and byte bounds before sending images", async () => {
    const { service, fetch } = setup("jev", "jev-latest");
    const definition = { question };
    for (const input of [
      Array.from({ length: 5 }, () => image),
      [{ ...image, image_url: imageUrl.replace("image/png", "image/jpeg") }],
      [{ ...image, image_url: imageUrl.replace("image/png", "image/webp") }],
      [{ ...image, image_url: pngDataUrl(279) }],
      [{ ...image, image_url: pngDataUrl(1569) }],
      [{ ...image, image_url: `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64")}` }],
    ]) {
      await expect(service.invoke(caller, { definition, input })).rejects.toMatchObject({ code: "invalid_image" });
    }
    expect(fetch).not.toHaveBeenCalled();
    await service.invoke(caller, { definition, input: [image] });
    await service.invoke(caller, { definition, input: [{ ...image, image_url: pngDataUrl(1568) }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps only image references and thumbnails across batch file reloads, including failures", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "decision-images-"));
    try {
      const { service, fetch } = setup("openai", "gpt-6-luna", directory);
      fetch.mockResolvedValueOnce(Response.json({ error: { message: imageUrl } }, { status: 400 }));
      const evidence = { case: "artwork" };
      const input = [{ type: "input_json", data: evidence }, image];
      const result = await service.invoke(caller, {
        definition: { question, inputSchema: { type: "object", required: ["case"], "x-pwragent-images": true } },
        inputs: [input, input],
        concurrency: 1,
      }) as { batchId: string; resultsFile: string; results: Array<Record<string, unknown>> };
      expect(result.results).toHaveLength(2);
      expect(result.results.every((item) => !("inputImages" in item))).toBe(true);
      const raw = await readFile(result.resultsFile, "utf8");
      expect(raw).not.toContain(imageUrl);
      const fresh = setup("openai", "gpt-6-luna", directory).service;
      const page = await fresh.railBatchPage(caller, { batchId: result.batchId, status: "all", limit: 5, from: 0 });
      expect(page.items.map((item) => item.ok)).toEqual([false, true]);
      for (const item of page.items) {
        expect(item.inputPreview).toBe(JSON.stringify(evidence));
        expect(item.inputImages).toEqual([{
          mimeType: "image/png", width: 280, height: 280,
          thumbnail: expect.stringMatching(/^data:image\/jpeg;base64,/),
        }]);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
