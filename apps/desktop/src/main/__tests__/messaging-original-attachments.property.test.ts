import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import { processMessagingAttachments } from "../messaging/core/messaging-attachment-processor";

describe("received original attachment invariant", () => {
  // Preview conversion must never discard the bytes or identity needed for a
  // byte-preserving save. The downloaded byte array is the oracle.
  it("retains every downloaded original before rendering, including one-page PDFs and binary files", async () => {
    await fc.assert(fc.asyncProperty(
      fc.uint8Array({ minLength: 1, maxLength: 100 }),
      fc.constantFrom("model_directed", "render_initial_pages", "pass_through"),
      async (suffix, pdfHandling) => {
        const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), suffix]);
        const binary = Buffer.concat([Buffer.from([0, 1, 2, 3]), suffix]);
        const retained: Uint8Array[] = [];
        const result = await processMessagingAttachments({
          adapter: {
            capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
            deliver: vi.fn(),
            downloadAttachment: async ({ attachment }) => ({
              data: attachment.name.endsWith(".pdf") ? pdf : binary,
              fileName: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.name.endsWith(".pdf") ? pdf.length : binary.length,
            }),
          },
          attachments: [
            { id: "provider-private-id", name: "report.pdf", kind: "file", disposition: "available", mimeType: "application/pdf" },
            { id: "other-provider-id", name: "archive.zip", kind: "file", disposition: "available", mimeType: "application/zip" },
          ],
          pdfHandling,
          retainOriginal: async (original) => {
            retained.push(original.data);
            return { attachmentId: `original-${retained.length}`, name: original.name,
              mimeType: original.mimeType ?? "application/octet-stream", sizeBytes: original.data.length,
              sha256: "synthetic-hash", receivedAt: 1, expiresAt: 2 };
          },
          dependencies: {
            inspectPdfDocument: async () => ({ pageCount: 1,
              firstPage: { width: 10, height: 10, renderWidth: 10, renderHeight: 10 } }),
            renderPdfPages: async () => [{ pageNumber: 1, base64: "AQID", mimeType: "image/png",
              encodedBytes: 3, width: 10, height: 10 }],
          },
        });
        expect(retained).toEqual([pdf, binary]);
        const prompt = result.input.filter((item) => item.type === "text").map((item) => item.text).join("\n");
        expect(prompt).toContain("original-1");
        expect(prompt).toContain("original-2");
        expect(prompt).toContain("export_messaging_attachment");
        expect(prompt).not.toContain("provider-private-id");
        expect(result.rejections).toEqual([]);
      },
    ), { numRuns: 12 });
  });
});
