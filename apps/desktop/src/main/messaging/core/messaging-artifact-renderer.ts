import { createHash } from "node:crypto";
import type {
  AppServerThreadPlanEntry,
  AppServerThreadPlanStep,
  AppServerThreadReviewEntry,
} from "@pwragent/shared";
import type {
  MessagingCapabilityProfile,
  MessagingMessageIntent,
} from "@pwragent/messaging-interface";

const INLINE_ONLY_THRESHOLD = 1_400;
const ATTACHMENT_SUMMARY_PREVIEW_CHARS = 1_400;
const INLINE_FALLBACK_PREVIEW_CHARS = 1_800;
const TRUNCATED_WITH_ATTACHMENT =
  "[Preview truncated. Open the attachment for the full artifact.]";
const TRUNCATED_INLINE_ONLY =
  "[Preview truncated. Attachment delivery is unavailable for this provider.]";

export type MessagingArtifactKind = "plan" | "review" | "markdown_file";

export type MessagingArtifact = {
  attachmentDescription?: string;
  attachmentName?: string;
  kind: MessagingArtifactKind;
  preferAttachment?: boolean;
  preserveMarkdown?: boolean;
  previewMarkdown?: string;
  previewTruncated?: boolean;
  title: string;
  summary?: string;
  markdown: string;
  steps?: AppServerThreadPlanStep[];
};

export type MessagingArtifactDeliveryMode =
  | "inline_only"
  | "attachment_summary"
  | "inline_fallback";

export type MessagingArtifactMessageIntent = MessagingMessageIntent & {
  artifactDelivery: {
    kind: MessagingArtifactKind;
    mode: MessagingArtifactDeliveryMode;
  };
};

export function buildPlanArtifactIntent(params: {
  bindingId?: string;
  capabilityProfile: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
  plan: AppServerThreadPlanEntry;
}): MessagingArtifactMessageIntent {
  const markdown = params.plan.markdown?.trim() || renderPlanMarkdown(params.plan);
  return buildArtifactDeliveryIntent({
    artifact: {
      kind: "plan",
      title: "Plan artifact",
      summary: params.plan.explanation,
      steps: params.plan.steps,
      markdown,
    },
    bindingId: params.bindingId,
    capabilityProfile: params.capabilityProfile,
    createdAt: params.createdAt,
    id: params.id,
  });
}

export function buildReviewArtifactIntent(params: {
  bindingId?: string;
  capabilityProfile: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
  review: AppServerThreadReviewEntry;
}): MessagingArtifactMessageIntent {
  const markdown = renderReviewMarkdown(params.review);
  return buildArtifactDeliveryIntent({
    artifact: {
      kind: "review",
      title: "Review artifact",
      summary: params.review.displayText,
      markdown,
    },
    bindingId: params.bindingId,
    capabilityProfile: params.capabilityProfile,
    createdAt: params.createdAt,
    id: params.id,
  });
}

export function buildArtifactDeliveryIntent(params: {
  artifact: MessagingArtifact;
  bindingId?: string;
  capabilityProfile: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
}): MessagingArtifactMessageIntent {
  const markdown = params.artifact.preserveMarkdown
    ? params.artifact.markdown
    : normalizeMarkdown(params.artifact.markdown);
  const inlineLimit = clampTextLimit(params.capabilityProfile, INLINE_ONLY_THRESHOLD);
  const canSendInlineOnly = markdown.length <= inlineLimit;
  const fileData = new TextEncoder().encode(markdown);
  const uploadLimit = params.capabilityProfile.outboundAttachments?.maxUploadBytes;
  const canAttach =
    params.capabilityProfile.outboundAttachments?.supportsFileUpload === true &&
    (uploadLimit === undefined || fileData.byteLength <= uploadLimit);
  const mode: MessagingArtifactDeliveryMode = params.artifact.preferAttachment
    ? canAttach
      ? "attachment_summary"
      : "inline_fallback"
    : canSendInlineOnly
      ? "inline_only"
      : canAttach
        ? "attachment_summary"
        : "inline_fallback";
  const text = mode === "inline_only"
    ? markdown
    : mode === "attachment_summary"
      ? formatAttachmentSummary({
          artifact: params.artifact,
          markdown,
          maxChars: clampTextLimit(
            params.capabilityProfile,
            ATTACHMENT_SUMMARY_PREVIEW_CHARS,
          ),
        })
      : formatInlineFallback({
          artifact: params.artifact,
          markdown,
          maxChars: clampTextLimit(
            params.capabilityProfile,
            INLINE_FALLBACK_PREVIEW_CHARS,
          ),
        });

  return {
    id: params.id,
    kind: "message",
    artifactDelivery: {
      kind: params.artifact.kind,
      mode,
    },
    bindingId: params.bindingId,
    createdAt: params.createdAt,
    role: "system",
    parts: [
      {
        type: "text",
        text,
        markdown: "markdown",
      },
      ...(mode === "attachment_summary"
        ? [
            {
              type: "file" as const,
              name: artifactFileName(params.artifact, markdown),
              data: fileData,
              mimeType: "text/markdown",
              sizeBytes: fileData.byteLength,
              description:
                params.artifact.attachmentDescription ??
                `Full ${params.artifact.kind} artifact`,
            },
          ]
        : []),
    ],
  };
}

export function buildArtifactInlineFallbackIntent(params: {
  artifact: MessagingArtifact;
  bindingId?: string;
  capabilityProfile: MessagingCapabilityProfile;
  createdAt: number;
  id: string;
}): MessagingArtifactMessageIntent {
  const markdown = normalizeMarkdown(params.artifact.markdown);
  return {
    id: params.id,
    kind: "message",
    artifactDelivery: {
      kind: params.artifact.kind,
      mode: "inline_fallback",
    },
    bindingId: params.bindingId,
    createdAt: params.createdAt,
    role: "system",
    parts: [
      {
        type: "text",
        text: formatInlineFallback({
          artifact: params.artifact,
          markdown,
          maxChars: clampTextLimit(
            params.capabilityProfile,
            INLINE_FALLBACK_PREVIEW_CHARS,
          ),
        }),
        markdown: "markdown",
      },
    ],
  };
}

export function planEntryFromUpdate(params: {
  createdAt: number;
  explanation?: string;
  id: string;
  markdown?: string;
  steps: AppServerThreadPlanStep[];
  turnId: string;
}): AppServerThreadPlanEntry {
  return {
    type: "plan",
    id: params.id,
    createdAt: params.createdAt,
    ...(params.explanation ? { explanation: params.explanation } : {}),
    ...(params.markdown ? { markdown: params.markdown } : {}),
    steps: params.steps,
    turn: {
      id: params.turnId,
    },
  };
}

export function artifactFromPlanEntry(plan: AppServerThreadPlanEntry): MessagingArtifact {
  return {
    kind: "plan",
    title: "Plan artifact",
    summary: plan.explanation,
    steps: plan.steps,
    markdown: plan.markdown?.trim() || renderPlanMarkdown(plan),
  };
}

export function artifactFromReviewEntry(review: AppServerThreadReviewEntry): MessagingArtifact {
  return {
    kind: "review",
    title: "Review artifact",
    summary: review.displayText,
    markdown: renderReviewMarkdown(review),
  };
}

function renderPlanMarkdown(plan: AppServerThreadPlanEntry): string {
  const lines = ["# Plan"];
  if (plan.explanation?.trim()) {
    lines.push("", plan.explanation.trim());
  }
  if (plan.steps.length > 0) {
    lines.push("", "## Steps");
    for (const step of plan.steps) {
      lines.push(`- [${statusCheckbox(step.status)}] ${step.step.trim()}`);
    }
  }
  return lines.join("\n").trim();
}

function renderReviewMarkdown(review: AppServerThreadReviewEntry): string {
  const lines = ["# Review"];
  if (review.displayText?.trim()) {
    lines.push("", review.displayText.trim());
  }
  if (review.review.trim()) {
    lines.push("", review.review.trim());
  }
  if (review.output) {
    lines.push("", "## Summary");
    lines.push(`- Correctness: ${review.output.overall_correctness}`);
    lines.push(`- Confidence: ${review.output.overall_confidence_score}`);
    lines.push(`- Explanation: ${review.output.overall_explanation}`);
    if (review.output.findings.length > 0) {
      lines.push("", "## Findings");
      for (const finding of review.output.findings) {
        lines.push(`- ${finding.title}: ${finding.body}`);
      }
    }
  }
  return lines.join("\n").trim();
}

function formatAttachmentSummary(params: {
  artifact: MessagingArtifact;
  markdown: string;
  maxChars: number;
}): string {
  const preview = formatArtifactPreview({
    artifact: params.artifact,
    markdown: params.markdown,
    maxChars: params.maxChars,
    marker: TRUNCATED_WITH_ATTACHMENT,
  });
  return boundedText(
    [
      `# ${params.artifact.title}`,
      params.artifact.summary,
      stepSummary(params.artifact.steps),
      "",
      preview,
    ],
    params.maxChars,
    TRUNCATED_WITH_ATTACHMENT,
  );
}

function formatInlineFallback(params: {
  artifact: MessagingArtifact;
  markdown: string;
  maxChars: number;
}): string {
  const preview = formatArtifactPreview({
    artifact: params.artifact,
    markdown: params.markdown,
    maxChars: params.maxChars,
    marker: TRUNCATED_INLINE_ONLY,
  });
  return boundedText(
    [
      `# ${params.artifact.title}`,
      params.artifact.summary,
      stepSummary(params.artifact.steps),
      "",
      preview,
    ],
    params.maxChars,
    TRUNCATED_INLINE_ONLY,
  );
}

function formatArtifactPreview(params: {
  artifact: MessagingArtifact;
  markdown: string;
  maxChars: number;
  marker: string;
}): string {
  if (params.artifact.previewMarkdown === undefined) {
    return truncateMarkdown(params.markdown, params.maxChars, params.marker);
  }
  const preview = truncateMarkdown(
    params.artifact.previewMarkdown,
    params.maxChars,
    params.marker,
  );
  if (!params.artifact.previewTruncated || preview.includes(params.marker)) {
    return preview;
  }
  return `${preview.trimEnd()}\n\n${params.marker}`;
}

function truncateMarkdown(markdown: string, maxChars: number, marker: string): string {
  if (markdown.length <= maxChars) {
    return markdown;
  }
  const available = Math.max(0, maxChars - marker.length - 2);
  const headingBreak = markdown.lastIndexOf("\n## ", available);
  const lineBreak = markdown.lastIndexOf("\n", available);
  const cutAt = headingBreak > 120 ? headingBreak : lineBreak > 120 ? lineBreak : available;
  return `${markdown.slice(0, cutAt).trimEnd()}\n\n${marker}`;
}

function boundedText(parts: Array<string | undefined>, maxChars: number, marker: string): string {
  const text = parts.filter((part): part is string => Boolean(part?.trim())).join("\n");
  return truncateMarkdown(text, maxChars, marker);
}

function stepSummary(steps: AppServerThreadPlanStep[] | undefined): string | undefined {
  if (!steps || steps.length === 0) {
    return undefined;
  }
  const pending = steps.filter((step) => step.status === "pending").length;
  const inProgress = steps.filter((step) => step.status === "in_progress").length;
  const completed = steps.filter((step) => step.status === "completed").length;
  return `Steps: ${completed} completed, ${inProgress} in progress, ${pending} pending`;
}

function clampTextLimit(
  capabilityProfile: MessagingCapabilityProfile,
  preferred: number,
): number {
  return Math.max(200, Math.min(preferred, capabilityProfile.text.maxLength));
}

function artifactFileName(artifact: MessagingArtifact, markdown: string): string {
  if (artifact.attachmentName?.trim()) {
    return artifact.attachmentName.trim();
  }
  const digest = createHash("sha256").update(markdown).digest("hex").slice(0, 10);
  return `${artifact.kind}-${digest}.md`;
}

function statusCheckbox(status: AppServerThreadPlanStep["status"]): string {
  return status === "completed" ? "x" : status === "in_progress" ? "-" : " ";
}

function normalizeMarkdown(markdown: string): string {
  return markdown.trim() || "# Artifact\n\nNo artifact content was provided.";
}
