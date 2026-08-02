import type { AppServerTurnInputItem } from "@pwragent/shared";
import { randomUUID } from "node:crypto";
import type {
  MessagingAttachmentDescriptor,
} from "@pwragent/messaging-interface";
import type { ImageUploadQualityProfile } from "../../../shared/image-normalization";
import { normalizeMessagingImageAttachment } from "../attachment-image-normalization";
import {
  DEFAULT_PDF_RENDER_LIMITS,
  renderPdfPages,
  renderedPdfPageDataUrl,
  renderedPdfPageWireBytes,
  type RenderedPdfPage,
} from "../../pdf/pdf-page-renderer";
import type { PendingPdfAttachment } from "../../pdf/pdf-attachment-store";
import type { MessagingAdapter } from "./messaging-adapter";
import {
  classifyMessagingAttachment,
  decodeMessagingTextAttachment,
} from "./messaging-attachment-mime";

export type MessagingAttachmentPolicy = {
  imageProfile: ImageUploadQualityProfile;
  pdfProfile: ImageUploadQualityProfile;
  maxAttachmentBytes: number;
  maxAttachmentCount: number;
  maxExtractedTextCharacters: number;
};

export type MessagingAttachmentRejection = {
  name: string;
  reason: string;
};

export type MessagingAttachmentProcessingResult = {
  input: AppServerTurnInputItem[];
  pdfAttachments: PendingPdfAttachment[];
  rejections: MessagingAttachmentRejection[];
};

export const DEFAULT_MESSAGING_ATTACHMENT_POLICY: MessagingAttachmentPolicy = {
  imageProfile: "medium",
  pdfProfile: "high",
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxAttachmentCount: 4,
  maxExtractedTextCharacters: 80_000,
};

export type MessagingAttachmentProcessingDependencies = {
  createPdfAttachmentId: () => string;
  renderPdfPages: (params: {
    data: Uint8Array;
    limits?: {
      maxEncodedBytes?: number;
      maxPageEncodedBytes?: number;
      maxPages?: number;
      maxPagePixels?: number;
      maxPixels?: number;
      maxWireBytes?: number;
    };
    pageNumbers?: number[];
    profile: ImageUploadQualityProfile;
  }) => Promise<RenderedPdfPage[]>;
};

const DEFAULT_DEPENDENCIES: MessagingAttachmentProcessingDependencies = {
  createPdfAttachmentId: randomUUID,
  renderPdfPages,
};

export async function processMessagingAttachments(params: {
  adapter: MessagingAdapter;
  attachments: MessagingAttachmentDescriptor[];
  policy?: Partial<MessagingAttachmentPolicy>;
  pdfHandling?: "model_directed" | "render_initial_pages" | "pass_through";
  text?: string;
  dependencies?: Partial<MessagingAttachmentProcessingDependencies>;
}): Promise<MessagingAttachmentProcessingResult> {
  const policy = {
    ...DEFAULT_MESSAGING_ATTACHMENT_POLICY,
    ...params.policy,
  };
  const dependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...params.dependencies,
  };
  const textInput: string[] = [];
  const mediaInput: AppServerTurnInputItem[] = [];
  const pdfAttachments: PendingPdfAttachment[] = [];
  const rejections: MessagingAttachmentRejection[] = [];
  const renderedPdfBudget = {
    bytes: 0,
    pages: 0,
    pixels: 0,
    wireBytes: 0,
  };

  const text = params.text?.trim();
  if (text) {
    textInput.push(text);
  }

  const attachments = params.attachments.slice(0, policy.maxAttachmentCount);
  if (params.attachments.length > policy.maxAttachmentCount) {
    rejections.push({
      name: "additional attachments",
      reason: `Only ${policy.maxAttachmentCount} attachments can be processed at once.`,
    });
  }

  for (const attachment of attachments) {
    if (attachment.disposition !== "available") {
      rejections.push({
        name: attachment.name,
        reason: attachment.reason ?? "Attachment type is not supported.",
      });
      continue;
    }
    if (attachment.sizeBytes && attachment.sizeBytes > policy.maxAttachmentBytes) {
      rejections.push({
        name: attachment.name,
        reason: "Attachment is larger than the configured limit.",
      });
      continue;
    }
    if (!params.adapter.downloadAttachment) {
      rejections.push({
        name: attachment.name,
        reason: "This messaging adapter cannot download attachments.",
      });
      continue;
    }

    try {
      const downloaded = await params.adapter.downloadAttachment({
        attachment,
        maxBytes: policy.maxAttachmentBytes,
      });
      if (downloaded.sizeBytes > policy.maxAttachmentBytes) {
        rejections.push({
          name: attachment.name,
          reason: "Attachment is larger than the configured limit.",
        });
        continue;
      }

      const classification = classifyMessagingAttachment({
        data: downloaded.data,
        fileName: downloaded.fileName,
        mimeType: downloaded.mimeType ?? attachment.mimeType,
      });

      if (classification.kind === "text") {
        const extracted = decodeMessagingTextAttachment(downloaded.data);
        if (extracted === undefined) {
          rejections.push({
            name: attachment.name,
            reason: "Attachment is not readable text.",
          });
          continue;
        }
        textInput.push(
          formatAttachmentText({
            content: truncateText(extracted, policy.maxExtractedTextCharacters),
            fileName: downloaded.fileName,
            mimeType: classification.mimeType,
            sizeBytes: downloaded.sizeBytes,
            truncated: extracted.length > policy.maxExtractedTextCharacters,
          }),
        );
        continue;
      }

      if (classification.kind === "pdf") {
        if (params.pdfHandling === "pass_through") {
          mediaInput.push({
            type: "file",
            name: downloaded.fileName,
            mimeType: classification.mimeType,
            data: Buffer.from(downloaded.data).toString("base64"),
            sizeBytes: downloaded.sizeBytes,
            pdfRenderProfile: policy.pdfProfile,
          });
          textInput.push(
            `PDF attachment \`${downloaded.fileName}\` was left as a normal file attachment.`,
          );
          continue;
        }
        if (params.pdfHandling === "model_directed") {
          pdfAttachments.push({
            attachmentId: dependencies.createPdfAttachmentId(),
            data: downloaded.data,
            name: downloaded.fileName,
            profile: policy.pdfProfile,
            sizeBytes: downloaded.sizeBytes,
          });
          textInput.push(
            `PDF attachment \`${downloaded.fileName}\` is available through PwrAgent's local PDF tools. Call inspect_messaging_pdfs first, use search_messaging_pdf_text for bounded navigation, then use render_messaging_pdf_pages to request only the pages needed for visual analysis.`,
          );
          continue;
        }
        const remainingPdfRenderLimits = {
          maxEncodedBytes:
            DEFAULT_PDF_RENDER_LIMITS.maxEncodedBytes - renderedPdfBudget.bytes,
          maxPageEncodedBytes: DEFAULT_PDF_RENDER_LIMITS.maxPageEncodedBytes,
          maxPages: DEFAULT_PDF_RENDER_LIMITS.maxPages - renderedPdfBudget.pages,
          maxPagePixels: DEFAULT_PDF_RENDER_LIMITS.maxPagePixels,
          maxPixels: DEFAULT_PDF_RENDER_LIMITS.maxPixels - renderedPdfBudget.pixels,
          maxWireBytes:
            DEFAULT_PDF_RENDER_LIMITS.maxWireBytes - renderedPdfBudget.wireBytes,
        };
        if (
          remainingPdfRenderLimits.maxEncodedBytes < 1 ||
          remainingPdfRenderLimits.maxPages < 1 ||
          remainingPdfRenderLimits.maxPixels < 1 ||
          remainingPdfRenderLimits.maxWireBytes < 1
        ) {
          rejections.push({
            name: attachment.name,
            reason: "PDF rendering budget was exhausted by earlier attachments.",
          });
          continue;
        }
        const pages = await dependencies.renderPdfPages({
          data: downloaded.data,
          limits: remainingPdfRenderLimits,
          profile: policy.pdfProfile,
        });
        if (pages.length === 0) {
          throw new Error("PDF has no renderable pages.");
        }
        renderedPdfBudget.bytes += pages.reduce(
          (total, page) => total + page.encodedBytes,
          0,
        );
        renderedPdfBudget.pages += pages.length;
        renderedPdfBudget.pixels += pages.reduce(
          (total, page) => total + page.width * page.height,
          0,
        );
        renderedPdfBudget.wireBytes += pages.reduce(
          (total, page) => total + renderedPdfPageWireBytes(page),
          0,
        );
        textInput.push(
          `Attachment \`${downloaded.fileName}\` was rendered into ${pages.length} page image${pages.length === 1 ? "" : "s"} for model input.`,
        );
        mediaInput.push(
          ...pages.map((page) => ({
            type: "image" as const,
            name: pdfPageImageName(downloaded.fileName, page.pageNumber),
            url: renderedPdfPageDataUrl(page),
          })),
        );
        continue;
      }

      if (classification.kind === "image" || classification.kind === "gif") {
        const normalized = await normalizeMessagingImageAttachment({
          data: downloaded.data,
          mimeType: classification.mimeType,
          profile: policy.imageProfile,
        });
        if (classification.kind === "gif") {
          textInput.push(
            `Attachment ${downloaded.fileName} was an animated GIF. I converted the first frame to a still image for model input.`,
          );
        }
        mediaInput.push({
          type: "image",
          name: downloaded.fileName,
          url: normalized.dataUrl,
        });
        continue;
      }

      rejections.push({
        name: attachment.name,
        reason: "Attachment type is not supported.",
      });
    } catch (error) {
      rejections.push({
        name: attachment.name,
        reason: error instanceof Error ? error.message : "Attachment could not be read.",
      });
    }
  }

  const input: AppServerTurnInputItem[] = [
    ...(textInput.length > 0
      ? [
          {
            type: "text" as const,
            text: textInput.join("\n\n"),
          },
        ]
      : []),
    ...mediaInput,
  ];

  return { input, pdfAttachments, rejections };
}

function pdfPageImageName(fileName: string, pageNumber: number): string {
  const baseName = fileName.replace(/\.pdf$/i, "") || fileName;
  return `${baseName}-page-${pageNumber}.png`;
}

function formatAttachmentText(params: {
  content: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  truncated: boolean;
}): string {
  const fence = markdownFenceFor(params.content);
  return [
    `Attached file: \`${params.fileName}\``,
    `Type: ${params.mimeType} | Size: ${formatByteSize(params.sizeBytes)}`,
    params.truncated ? "Content was truncated to the configured limit." : undefined,
    "",
    `${fence}${markdownLanguageFor(params.fileName, params.mimeType)}`,
    params.content,
    fence,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  const kib = bytes / 1024;
  if (kib < 1024) {
    return `${kib.toFixed(kib >= 10 ? 0 : 1)} KB`;
  }
  const mib = kib / 1024;
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MB`;
}

function markdownLanguageFor(fileName: string, mimeType: string): string {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();
  if (lowerName.endsWith(".json") || lowerMime.includes("json")) {
    return "json";
  }
  if (lowerName.endsWith(".jsonl") || lowerMime.includes("ndjson")) {
    return "jsonl";
  }
  if (lowerName.endsWith(".csv")) {
    return "csv";
  }
  if (lowerName.endsWith(".toml") || lowerMime.includes("toml")) {
    return "toml";
  }
  if (
    lowerName.endsWith(".yaml") ||
    lowerName.endsWith(".yml") ||
    lowerMime.includes("yaml")
  ) {
    return "yaml";
  }
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return "markdown";
  }
  return "text";
}

function markdownFenceFor(content: string): string {
  const longestFence = Math.max(
    2,
    ...[...content.matchAll(/`+/g)].map((match) => match[0]?.length ?? 0),
  );
  return "`".repeat(longestFence + 1);
}

function truncateText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text;
  }
  return `${text.slice(0, maxCharacters)}\n[attachment truncated]`;
}
