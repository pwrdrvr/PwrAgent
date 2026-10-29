import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  fetchLinearPastedImages,
  type LinearPastedImagesOptions,
} from "../mcp-connections/linear-pasted-images";

const FILE = "https://uploads.linear.app/org/issue/file";
const PNG = Buffer.from("png-bytes").toString("base64");
const NOW = 1_793_243_811_000;
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A Linear upload signature with the given claims. Linear verifies the MAC, not us. */
function signed(file: string, expiresInSeconds: number, path = new URL(file).pathname): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(NOW / 1000) - 10;
  const token = [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ path, iat, exp: Math.floor(NOW / 1000) + expiresInSeconds }),
    "mac",
  ].join(".");
  return `${file}?signature=${token}`;
}

function imageResponse(bytes: Uint8Array, contentType = "image/png"): Response {
  return new Response(bytes, { status: 200, headers: { "content-type": contentType } });
}

function pasted(src: string, alt = "shot.png"): string {
  return `<issue identifier="PWR-5"><description><linear-image quality="preview">${JSON.stringify({
    type: "image",
    attrs: { src, alt },
  })}</linear-image></description></issue>`;
}

function session(result: CallToolResult | Error) {
  return {
    callTool: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    close: vi.fn(),
  };
}

function options(
  sessions: Record<string, ReturnType<typeof session>>,
  // `null` stands for the setting being off; a default parameter would
  // swallow an explicit `undefined`.
  connectionIds: string[] | null = Object.keys(sessions),
): LinearPastedImagesOptions & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    connectionIds: connectionIds ?? undefined,
    // No test reaches the network; a direct fetch must be stubbed explicitly.
    fetch: vi.fn(async () => {
      throw new Error("unexpected direct fetch");
    }),
    now: () => NOW,
    openSession: async ({ connectionId }) => {
      opened.push(connectionId);
      const found = sessions[connectionId];
      if (!found) throw new Error(`${connectionId} is not connected to PwrAgent.`);
      return found;
    },
  };
}

describe("fetchLinearPastedImages", () => {
  it("asks extract_images for the unsigned file and returns the image", async () => {
    const linear = session({
      content: [
        { type: "text", text: "Successfully fetched 1 image." },
        { type: "text", text: "Image: attention-lens-mark-read.png" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
    });

    const response = await fetchLinearPastedImages(
      pasted(`${FILE}?signature=expired`),
      options({ linear }),
    );

    expect(response).toEqual({
      status: "fetched",
      failed: 0,
      images: [{ name: "attention-lens-mark-read.png", mimeType: "image/png", dataBase64: PNG }],
    });
    expect(linear.callTool).toHaveBeenCalledWith("extract_images", {
      markdown: `![shot.png](${FILE})`,
    });
    expect(linear.close).toHaveBeenCalledOnce();
  });

  it("does nothing for text without Linear images", async () => {
    const linear = session(new Error("not called"));
    const opts = options({ linear });

    await expect(fetchLinearPastedImages("plain text", opts)).resolves.toEqual({
      status: "fetched",
      images: [],
      failed: 0,
    });
    expect(opts.opened).toEqual([]);
  });

  it("reports the setting off and a missing connection without opening a session", async () => {
    await expect(fetchLinearPastedImages(pasted(FILE), options({}, null)))
      .resolves.toEqual({ status: "disabled" });
    await expect(fetchLinearPastedImages(pasted(FILE), options({}, [])))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("tries the next Linear connection when one cannot read the file", async () => {
    const first = session({ isError: true, content: [{ type: "text", text: "Not found" }] });
    const second = session({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] });

    const response = await fetchLinearPastedImages(pasted(FILE), options({ first, second }));

    expect(response).toMatchObject({
      status: "fetched",
      images: [{ name: "shot.png", mimeType: "image/png" }],
    });
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("names the last failure when no connection returns an image", async () => {
    const opts = options({}, ["linear"]);

    await expect(fetchLinearPastedImages(pasted(FILE), opts)).resolves.toEqual({
      status: "failed",
      message: "linear is not connected to PwrAgent.",
    });
  });

  it("drops non-image content and counts what did not arrive", async () => {
    const text = `${pasted(`${FILE}-a`, "a.png")}${pasted(`${FILE}-b`, "b.svg")}`;
    const linear = session({
      content: [
        { type: "image", data: PNG, mimeType: "image/png" },
        { type: "image", data: PNG, mimeType: "image/svg+xml" },
      ],
    });

    await expect(fetchLinearPastedImages(text, options({ linear }))).resolves.toEqual({
      status: "fetched",
      failed: 1,
      images: [{ name: "a.png", mimeType: "image/png", dataBase64: PNG }],
    });
  });

  it("keeps Markdown syntax out of the label it sends", async () => {
    const linear = session({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] });

    await fetchLinearPastedImages(pasted(FILE, "a](https://evil)[b"), options({ linear }));

    expect(linear.callTool).toHaveBeenCalledWith("extract_images", {
      markdown: `![ahttps://evilb](${FILE})`,
    });
  });
});

describe("fetchLinearPastedImages with a fresh signed link", () => {
  it("fetches the signed link directly, with no Linear connection", async () => {
    const opts = options({}, []);
    opts.fetch = vi.fn(async () => imageResponse(PNG_BYTES));
    const link = signed(FILE, 240);

    await expect(fetchLinearPastedImages(pasted(link), opts)).resolves.toEqual({
      status: "fetched",
      failed: 0,
      images: [{
        name: "shot.png",
        mimeType: "image/png",
        dataBase64: Buffer.from(PNG_BYTES).toString("base64"),
      }],
    });
    expect(opts.fetch).toHaveBeenCalledWith(link, expect.objectContaining({ redirect: "error" }));
    expect(opts.opened).toEqual([]);
  });

  it("leaves an expired link to the MCP", async () => {
    const linear = session({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    const opts = options({ linear });

    await expect(fetchLinearPastedImages(pasted(signed(FILE, -60)), opts))
      .resolves.toMatchObject({ status: "fetched", failed: 0 });
    expect(opts.fetch).not.toHaveBeenCalled();
    expect(opts.opened).toEqual(["linear"]);
  });

  it("says a connection is needed when an expired link has none", async () => {
    await expect(fetchLinearPastedImages(pasted(signed(FILE, -60)), options({}, [])))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("attaches the fresh images and flags the expired ones when there is no connection", async () => {
    const opts = options({}, []);
    opts.fetch = vi.fn(async () => imageResponse(PNG_BYTES));
    const text = `${pasted(signed(`${FILE}-a`, 240), "a.png")}${pasted(signed(`${FILE}-b`, -60), "b.png")}`;

    await expect(fetchLinearPastedImages(text, opts)).resolves.toMatchObject({
      status: "fetched",
      failed: 1,
      needsConnection: true,
      images: [{ name: "a.png" }],
    });
  });

  it("falls back to the MCP when the direct fetch is refused", async () => {
    const linear = session({ content: [{ type: "image", data: PNG, mimeType: "image/png" }] });
    const opts = options({ linear });
    opts.fetch = vi.fn(async () => new Response("denied", { status: 403 }));

    await expect(fetchLinearPastedImages(pasted(signed(FILE, 240)), opts))
      .resolves.toMatchObject({ status: "fetched", images: [{ dataBase64: PNG }] });
    expect(opts.opened).toEqual(["linear"]);
  });

  it("keeps only bytes that are a raster image, whatever the header says", async () => {
    const opts = options({}, []);
    opts.fetch = vi.fn(async () =>
      imageResponse(new TextEncoder().encode("<svg onload=alert(1)>"), "image/png")
    );

    await expect(fetchLinearPastedImages(pasted(signed(FILE, 240)), opts))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("refuses a body larger than the cap", async () => {
    const opts = options({}, []);
    opts.fetch = vi.fn(async () => new Response(PNG_BYTES, {
      status: 200,
      headers: { "content-length": String(26 * 1024 * 1024) },
    }));

    await expect(fetchLinearPastedImages(pasted(signed(FILE, 240)), opts))
      .resolves.toEqual({ status: "unavailable" });
  });

  it("does not use a signature granted for a different file", async () => {
    const opts = options({}, []);

    await expect(
      fetchLinearPastedImages(pasted(signed(FILE, 240, "/org/issue/other")), opts),
    ).resolves.toEqual({ status: "unavailable" });
    expect(opts.fetch).not.toHaveBeenCalled();
  });

  it("does nothing at all when the setting is off", async () => {
    const opts = options({}, null);

    await expect(fetchLinearPastedImages(pasted(signed(FILE, 240)), opts))
      .resolves.toEqual({ status: "disabled" });
    expect(opts.fetch).not.toHaveBeenCalled();
  });
});
