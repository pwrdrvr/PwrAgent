import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PdfAttachmentStore } from "../pdf/pdf-attachment-store";
import {
  handlePwrAgentPdfToolRequest,
} from "../pdf/pwragent-pdf-agent-tools";

const jeepStickerPageFixture = fileURLToPath(
  new URL("./fixtures/pdf/jeep-sticker-page-size.pdf", import.meta.url),
);
const context = {
  backend: "codex" as const,
  threadId: "thread-1",
  turnId: "turn-1",
};

describe("PwrAgent PDF agent tools", () => {
  it("serves desktop-origin PDFs through the existing bounded dynamic-tool contract", async () => {
    const data = await readFile(jeepStickerPageFixture);
    const store = new PdfAttachmentStore();
    store.bindTurn(context, [
      {
        attachmentId: "jeep-pdf",
        data,
        name: "Jeep",
        profile: "high",
        sizeBytes: data.byteLength,
      },
    ]);

    const response = await handlePwrAgentPdfToolRequest({
      request: {
        operation: "inspect_messaging_pdfs",
        context,
        args: {},
      },
      store,
    });

    expect(response).toMatchObject({
      ok: true,
      data: {
        attachments: [
          expect.objectContaining({
            attachmentId: "jeep-pdf",
            name: "Jeep",
            pageCount: 1,
            firstPage: {
              width: 1224,
              height: 792,
              renderWidth: 3072,
              renderHeight: 1988,
            },
          }),
        ],
      },
    });
  });

  it("defers an unowned PDF turn to the messaging-origin tool service", async () => {
    await expect(
      handlePwrAgentPdfToolRequest({
        request: {
          operation: "inspect_messaging_pdfs",
          context,
          args: {},
        },
        store: new PdfAttachmentStore(),
      }),
    ).resolves.toBeUndefined();
  });
});
