import { describe, expect, it } from "vitest";
import {
  classifyMessagingAttachment,
  decodeMessagingTextAttachment,
} from "../messaging/core/messaging-attachment-mime";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("messaging attachment MIME classification", () => {
  it("classifies text-like file types by extension and content", () => {
    for (const fileName of [
      "streaming-logs.txt",
      "data.csv",
      "payload.json",
      "events.jsonl",
      "config.toml",
      "workflow.yaml",
      "workflow.yml",
      "notes.md",
      "app.log",
    ]) {
      expect(
        classifyMessagingAttachment({
          data: bytes("hello\nworld\n"),
          fileName,
        }),
      ).toMatchObject({ kind: "text" });
    }
  });

  it("does not trust a text extension when bytes look binary", () => {
    expect(
      classifyMessagingAttachment({
        data: new Uint8Array([0, 1, 2, 3]),
        fileName: "secret.txt",
        mimeType: "text/plain",
      }),
    ).toMatchObject({ kind: "binary" });
  });

  it("prefers magic bytes for images and PDFs", () => {
    expect(
      classifyMessagingAttachment({
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]),
        fileName: "image.bin",
      }),
    ).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(
      classifyMessagingAttachment({
        data: bytes("%PDF-1.7\n"),
        fileName: "file.bin",
      }),
    ).toMatchObject({ kind: "pdf" });
  });

  it("decodes plain text attachments", () => {
    expect(decodeMessagingTextAttachment(bytes("alpha\nbeta"))).toBe("alpha\nbeta");
    expect(decodeMessagingTextAttachment(new Uint8Array([1, 0, 2]))).toBeUndefined();
  });
});
