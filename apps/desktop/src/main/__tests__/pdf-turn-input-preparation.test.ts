import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  preparePdfTurnInput,
} from "../pdf/pdf-turn-input-preparation";

const jeepStickerPageFixture = fileURLToPath(
  new URL("./fixtures/pdf/jeep-sticker-page-size.pdf", import.meta.url),
);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

async function makeExtensionlessFixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-pdf-turn-"));
  tempRoots.push(root);
  const fixturePath = path.join(root, "Jeep");
  await copyFile(jeepStickerPageFixture, fixturePath);
  return fixturePath;
}

describe("preparePdfTurnInput", () => {
  it("recognizes an extensionless explicit local PDF and keeps it local for page tools", async () => {
    const pdfPath = await makeExtensionlessFixture();
    const renderPdfPages = vi.fn();

    const prepared = await preparePdfTurnInput({
      handling: "model_directed",
      input: [
        {
          type: "text",
          text: `Compare [@Jeep](${pdfPath}) and keep [@notes](/tmp/notes.txt).`,
        },
        { type: "localFile", name: "Jeep", path: pdfPath },
      ],
      dependencies: {
        createAttachmentId: () => "jeep-pdf",
        renderPdfPages,
      },
    });

    expect(renderPdfPages).not.toHaveBeenCalled();
    expect(prepared.input).toEqual([
      { type: "text", text: "Compare @Jeep and keep [@notes](/tmp/notes.txt)." },
      {
        type: "text",
        text: expect.stringContaining("inspect_messaging_pdfs"),
      },
    ]);
    expect(prepared.pdfAttachments).toEqual([
      expect.objectContaining({
        attachmentId: "jeep-pdf",
        name: "Jeep",
        profile: "high",
        sizeBytes: expect.any(Number),
      }),
    ]);
    expect(prepared.input[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("already adds those images to model context"),
    });
  });

  it("keeps an explicit local PDF reference intact when analysis is disabled", async () => {
    const pdfPath = "/private/var/tmp/PwrAgent/Jeep";

    const prepared = await preparePdfTurnInput({
      handling: "pass_through",
      input: [
        {
          type: "text",
          text: `Let the model inspect [@Jeep](${pdfPath}) itself.`,
        },
        { type: "localFile", name: "Jeep", path: pdfPath },
      ],
    });

    expect(prepared).toEqual({
      input: [
        {
          type: "text",
          text: `Let the model inspect [@Jeep](${pdfPath}) itself.`,
        },
        { type: "localFile", name: "Jeep", path: pdfPath },
      ],
      pdfAttachments: [],
    });
  });

  it("keeps an explicit non-PDF local file as a backend reference", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-file-turn-"));
    tempRoots.push(root);
    const textPath = path.join(root, "notes.txt");
    await writeFile(textPath, "not a PDF");

    await expect(
      preparePdfTurnInput({
        handling: "model_directed",
        input: [
          { type: "text", text: "Read these notes." },
          { type: "localFile", name: "notes.txt", path: textPath },
        ],
      }),
    ).resolves.toEqual({
      input: [
        { type: "text", text: "Read these notes." },
        { type: "localFile", name: "notes.txt", path: textPath },
      ],
      pdfAttachments: [],
    });
  });
});
