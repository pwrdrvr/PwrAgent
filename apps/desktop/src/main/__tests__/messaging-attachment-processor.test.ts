import { describe, expect, it, vi } from "vitest";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import type {
  MessagingAdapter,
} from "../messaging/core/messaging-adapter";
import {
  processMessagingAttachments,
} from "../messaging/core/messaging-attachment-processor";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function createAdapter(dataByName: Record<string, Uint8Array>): MessagingAdapter {
  return {
    capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
    deliver: vi.fn(),
    downloadAttachment: vi.fn(async ({ attachment }) => {
      const data = dataByName[attachment.name] ?? new Uint8Array();
      return {
        data,
        fileName: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: data.byteLength,
      };
    }),
  };
}

describe("processMessagingAttachments", () => {
  it("turns text attachments into bounded text input", async () => {
    const adapter = createAdapter({
      "streaming-logs.txt": bytes("line one\nline two"),
    });

    const result = await processMessagingAttachments({
      adapter,
      attachments: [
        {
          id: "file-1",
          kind: "file",
          name: "streaming-logs.txt",
          disposition: "available",
          mimeType: "text/plain",
          sizeBytes: 18,
        },
      ],
      text: "Please inspect this log",
    });

    expect(result.rejections).toEqual([]);
    expect(result.input).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Please inspect this log\n\nAttached file: `streaming-logs.txt`"),
      },
    ]);
    expect(result.input[0]).toMatchObject({
      text: expect.stringContaining("```text\nline one\nline two\n```"),
    });
  });

  it("rejects binary bytes disguised as text", async () => {
    const result = await processMessagingAttachments({
      adapter: createAdapter({
        "secret.txt": new Uint8Array([0, 1, 2, 3]),
      }),
      attachments: [
        {
          id: "file-1",
          kind: "file",
          name: "secret.txt",
          disposition: "available",
          mimeType: "text/plain",
          sizeBytes: 4,
        },
      ],
    });

    expect(result.input).toEqual([]);
    expect(result.rejections).toEqual([
      {
        name: "secret.txt",
        reason: "Attachment type is not supported.",
      },
    ]);
  });

  it("rejects oversize attachments before downloading", async () => {
    const adapter = createAdapter({});

    const result = await processMessagingAttachments({
      adapter,
      attachments: [
        {
          id: "file-1",
          kind: "file",
          name: "huge.log",
          disposition: "available",
          mimeType: "text/plain",
          sizeBytes: 99,
        },
      ],
      policy: {
        maxAttachmentBytes: 10,
      },
    });

    expect(adapter.downloadAttachment).not.toHaveBeenCalled();
    expect(result.rejections[0]).toMatchObject({
      name: "huge.log",
      reason: "Attachment is larger than the configured limit.",
    });
  });

  it("renders PDFs into page images without normalizing the rendered output", async () => {
    const adapter = createAdapter({
      "readable.pdf": bytes("%PDF-1.7\n(hello pdf) Tj\n"),
    });
    const renderPdfPages = vi.fn(async () => [
      {
        dataUrl: "data:image/png;base64,first-page",
        height: 1988,
        pageNumber: 1,
        width: 3072,
      },
      {
        dataUrl: "data:image/png;base64,second-page",
        height: 1988,
        pageNumber: 2,
        width: 3072,
      },
    ]);

    const result = await processMessagingAttachments({
      adapter,
      attachments: [
        {
          id: "pdf-1",
          kind: "file",
          name: "readable.pdf",
          disposition: "available",
          mimeType: "application/pdf",
        },
      ],
      dependencies: { renderPdfPages },
    });

    expect(renderPdfPages).toHaveBeenCalledWith({
      data: bytes("%PDF-1.7\n(hello pdf) Tj\n"),
      profile: "high",
    });
    expect(result.rejections).toEqual([]);
    expect(result.input).toEqual([
      {
        type: "text",
        text: "Attachment `readable.pdf` was rendered into 2 page images for model input.",
      },
      {
        type: "image",
        name: "readable-page-1.png",
        url: "data:image/png;base64,first-page",
      },
      {
        type: "image",
        name: "readable-page-2.png",
        url: "data:image/png;base64,second-page",
      },
    ]);
  });
});
