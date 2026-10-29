import { describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  fetchLinearPastedImages,
  type LinearPastedImagesOptions,
} from "../mcp-connections/linear-pasted-images";

const FILE = "https://uploads.linear.app/org/issue/file";
const PNG = Buffer.from("png-bytes").toString("base64");

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
  connectionIds: string[] | undefined = Object.keys(sessions),
): LinearPastedImagesOptions & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    connectionIds,
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
    await expect(fetchLinearPastedImages(pasted(FILE), options({}, undefined)))
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
