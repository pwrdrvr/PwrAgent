import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  PWRAGENT_TOOL_NAMESPACE,
} from "@pwragent/shared";
import { describe, expect, it } from "vitest";
import {
  buildPwrAgentMessagingToolRouter,
} from "../agent-tools/pwragent-messaging-agent-tools";
import { PdfAttachmentStore } from "../pdf/pdf-attachment-store";
import {
  handlePwrAgentPdfToolRequest,
} from "../pdf/pwragent-pdf-agent-tools";
import { MAX_PDF_TEXT_SEARCH_REQUESTS_PER_TURN } from "../pdf/pdf-turn-guidance";

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

  it("rejects text search for a one-page PDF and directs the model to render it", async () => {
    const data = await readFile(jeepStickerPageFixture);
    const store = new PdfAttachmentStore();
    store.bindTurn(context, [
      {
        attachmentId: "jeep-pdf",
        data,
        inspection: {
          firstPage: {
            height: 792,
            renderHeight: 1988,
            renderWidth: 3072,
            width: 1224,
          },
          pageCount: 1,
        },
        name: "Jeep",
        profile: "high",
        sizeBytes: data.byteLength,
      },
    ]);

    await expect(
      handlePwrAgentPdfToolRequest({
        request: {
          operation: "search_messaging_pdf_text",
          context,
          args: {
            attachmentId: "jeep-pdf",
            query: "MSRP",
          },
        },
        store,
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: "unsupported_operation",
        message:
          "Text search is unavailable for `Jeep` because it has one page. Render page 1 directly and analyze the image.",
      },
    });
  });

  it("caps concurrent multi-page text searches for a turn", async () => {
    const data = await readFile(roadsterEquipmentFixture);
    const store = new PdfAttachmentStore();
    store.bindTurn(context, [
      {
        attachmentId: "roadster-pdf",
        data,
        inspection: {
          firstPage: {
            height: 792,
            renderHeight: 1224,
            renderWidth: 792,
            width: 612,
          },
          pageCount: 3,
        },
        name: "Roadster equipment record",
        profile: "low",
        sizeBytes: data.byteLength,
      },
    ]);

    const responses = await Promise.all(
      Array.from(
        { length: MAX_PDF_TEXT_SEARCH_REQUESTS_PER_TURN + 1 },
        async (_, index) => await handlePwrAgentPdfToolRequest({
          request: {
            operation: "search_messaging_pdf_text",
            context,
            args: {
              attachmentId: "roadster-pdf",
              query: `option ${index + 1}`,
            },
          },
          store,
        }),
      ),
    );

    expect(responses.filter((response) => response?.ok)).toHaveLength(
      MAX_PDF_TEXT_SEARCH_REQUESTS_PER_TURN,
    );
    expect(responses.filter((response) => !response?.ok)).toEqual([
      {
        ok: false,
        error: {
          code: "unsupported_operation",
          message: `PDF text search is limited to ${MAX_PDF_TEXT_SEARCH_REQUESTS_PER_TURN} calls per turn. Render the identified pages and analyze the images.`,
        },
      },
    ]);
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
          imageUrl: expect.stringMatching(/^data:image\/png;base64,/),
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
          imageUrl: expect.stringMatching(/^data:image\/png;base64,/),
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
