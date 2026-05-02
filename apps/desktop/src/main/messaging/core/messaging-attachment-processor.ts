import type {
  AppServerTurnInputItem,
  MessagingAttachmentDescriptor,
} from "@pwragnt/shared";
import type { ImageUploadQualityProfile } from "../../../shared/image-normalization";
import { normalizeMessagingImageAttachment } from "../attachment-image-normalization";
import type { MessagingAdapter } from "./messaging-adapter";
import {
  classifyMessagingAttachment,
  decodeMessagingTextAttachment,
} from "./messaging-attachment-mime";

export type MessagingAttachmentPolicy = {
  imageProfile: ImageUploadQualityProfile;
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
  rejections: MessagingAttachmentRejection[];
};

export const DEFAULT_MESSAGING_ATTACHMENT_POLICY: MessagingAttachmentPolicy = {
  imageProfile: "medium",
  maxAttachmentBytes: 10 * 1024 * 1024,
  maxAttachmentCount: 4,
  maxExtractedTextCharacters: 80_000,
};

export async function processMessagingAttachments(params: {
  adapter: MessagingAdapter;
  attachments: MessagingAttachmentDescriptor[];
  policy?: Partial<MessagingAttachmentPolicy>;
  text?: string;
}): Promise<MessagingAttachmentProcessingResult> {
  const policy = {
    ...DEFAULT_MESSAGING_ATTACHMENT_POLICY,
    ...params.policy,
  };
  const input: AppServerTurnInputItem[] = [];
  const rejections: MessagingAttachmentRejection[] = [];

  const text = params.text?.trim();
  if (text) {
    input.push({ type: "text", text });
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
        input.push({
          type: "text",
          text: formatAttachmentText({
            content: truncateText(extracted, policy.maxExtractedTextCharacters),
            fileName: downloaded.fileName,
            mimeType: classification.mimeType,
            sizeBytes: downloaded.sizeBytes,
            truncated: extracted.length > policy.maxExtractedTextCharacters,
          }),
        });
        continue;
      }

      if (classification.kind === "pdf") {
        const extracted = extractBasicPdfText(downloaded.data);
        if (!extracted) {
          rejections.push({
            name: attachment.name,
            reason: "PDF text could not be extracted.",
          });
          continue;
        }
        input.push({
          type: "text",
          text: formatAttachmentText({
            content: truncateText(extracted, policy.maxExtractedTextCharacters),
            fileName: downloaded.fileName,
            mimeType: classification.mimeType,
            sizeBytes: downloaded.sizeBytes,
            truncated: extracted.length > policy.maxExtractedTextCharacters,
          }),
        });
        continue;
      }

      if (classification.kind === "image" || classification.kind === "gif") {
        const normalized = await normalizeMessagingImageAttachment({
          data: downloaded.data,
          mimeType: classification.mimeType,
          profile: policy.imageProfile,
        });
        if (classification.kind === "gif") {
          input.push({
            type: "text",
            text: `Attachment ${downloaded.fileName} was an animated GIF. I converted the first frame to a still image for model input.`,
          });
        }
        input.push({
          type: "image",
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

  return { input, rejections };
}

function formatAttachmentText(params: {
  content: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  truncated: boolean;
}): string {
  return [
    `Attachment: ${params.fileName}`,
    `MIME type: ${params.mimeType}`,
    `Size: ${params.sizeBytes} bytes`,
    params.truncated ? "Content was truncated to the configured limit." : undefined,
    "",
    params.content,
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function truncateText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) {
    return text;
  }
  return `${text.slice(0, maxCharacters)}\n[attachment truncated]`;
}

function extractBasicPdfText(data: Uint8Array): string | undefined {
  const decoded = new TextDecoder("latin1", { fatal: false }).decode(data);
  const matches = [...decoded.matchAll(/\(([^()]*)\)\s*Tj/g)]
    .map((match) => match[1]?.replace(/\\([()\\])/g, "$1").trim())
    .filter((value): value is string => Boolean(value));
  return matches.length > 0 ? matches.join("\n") : undefined;
}
