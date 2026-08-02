import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PWRAGENT_TOOL_NAMESPACE } from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  buildPwrAgentMessagingToolRouter,
} from "../agent-tools/pwragent-messaging-agent-tools";
import { PdfAttachmentStore } from "../pdf/pdf-attachment-store";
import {
  handlePwrAgentPdfToolRequest,
} from "../pdf/pwragent-pdf-agent-tools";

const jeepStickerPageFixture = fileURLToPath(
  new URL("./fixtures/pdf/jeep-sticker-page-size.pdf", import.meta.url),
);
const roadsterEquipmentFixture = fileURLToPath(
  new URL("../../../eval/pdf-fixtures/roadster-equipment-record.pdf", import.meta.url),
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

  it("adds each rendered PDF page to model input only once per turn", async () => {
    const data = await readFile(roadsterEquipmentFixture);
    const store = new PdfAttachmentStore();
    store.bindTurn(context, [
      {
        attachmentId: "roadster-pdf",
        data,
        name: "Roadster equipment record",
        profile: "low",
        sizeBytes: data.byteLength,
      },
    ]);
    const router = buildPwrAgentMessagingToolRouter(async (request) => {
      const response = await handlePwrAgentPdfToolRequest({ request, store });
      if (!response) {
        throw new Error("Expected the PDF store to own this turn.");
      }
      return response;
    });
    let callNumber = 0;
    const render = async (pageNumbers: number[]) => await router.handleDynamicToolCall({
      backend: "codex",
      call: {
        arguments: { attachmentId: "roadster-pdf", pageNumbers },
        callId: `call-${callNumber += 1}`,
        namespace: PWRAGENT_TOOL_NAMESPACE,
        threadId: context.threadId,
        tool: "render_messaging_pdf_pages",
        turnId: context.turnId,
      },
    });

    const first = await render([1]);
    expect(first).toMatchObject({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: expect.stringContaining("already added the rendered PDF page image"),
        },
        {
          type: "inputImage",
          imageUrl: expect.stringMatching(/^data:image\/png;base64,/u),
        },
      ],
    });

    const partialRepeat = await render([1, 2]);
    expect(partialRepeat).toMatchObject({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: expect.stringContaining('"alreadySuppliedPageNumbers": [\n    1\n  ]'),
        },
        {
          type: "inputImage",
          imageUrl: expect.stringMatching(/^data:image\/png;base64,/u),
        },
      ],
    });
    expect(partialRepeat.contentItems).toHaveLength(2);

    const repeat = await render([1, 2]);
    expect(repeat).toEqual({
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: expect.stringContaining("already supplied the requested PDF page image"),
        },
      ],
    });

    store.releaseTurn(context);
    store.bindTurn(context, [
      {
        attachmentId: "roadster-pdf",
        data,
        name: "Roadster equipment record",
        profile: "low",
        sizeBytes: data.byteLength,
      },
    ]);
    const concurrent = await Promise.all([render([1]), render([1])]);
    expect(
      concurrent.flatMap((response) => response.contentItems)
        .filter((item) => item.type === "inputImage"),
    ).toHaveLength(1);
  });
});
