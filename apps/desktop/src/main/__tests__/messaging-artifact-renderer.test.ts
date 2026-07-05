import { describe, expect, it } from "vitest";
import type { MessagingCapabilityProfile } from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import {
  buildArtifactDeliveryIntent,
  buildPlanArtifactIntent,
} from "../messaging/core/messaging-artifact-renderer";

describe("messaging artifact renderer", () => {
  it("renders short plans inline without a file part", () => {
    const intent = buildPlanArtifactIntent({
      capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
      createdAt: 1000,
      id: "plan-short",
      plan: {
        type: "plan",
        id: "plan-1",
        steps: [{ step: "Write the test", status: "pending" }],
      },
    });

    expect(intent.artifactDelivery).toEqual({
      kind: "plan",
      mode: "inline_only",
    });
    expect(intent.parts).toHaveLength(1);
    expect(intent.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Write the test"),
    });
  });

  it("adds a markdown attachment and bounded preview for long artifacts when upload is supported", () => {
    const markdown = longMarkdown();
    const intent = buildArtifactDeliveryIntent({
      artifact: {
        kind: "review",
        title: "Review artifact",
        summary: "Review completed",
        markdown,
      },
      capabilityProfile: PERMISSIVE_CAPABILITY_PROFILE,
      createdAt: 1000,
      id: "review-long",
    });

    expect(intent.artifactDelivery.mode).toBe("attachment_summary");
    expect(intent.parts).toHaveLength(2);
    expect(intent.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Open the attachment"),
    });
    expect(intent.parts[1]).toMatchObject({
      type: "file",
      mimeType: "text/markdown",
      name: expect.stringMatching(/^review-[a-f0-9]{10}\.md$/),
      sizeBytes: new TextEncoder().encode(markdown.trim()).byteLength,
    });
  });

  it("falls back to inline preview when provider cannot upload files", () => {
    const textOnlyProfileWithUndefinedOutbound: MessagingCapabilityProfile = {
      ...PERMISSIVE_CAPABILITY_PROFILE,
      text: {
        ...PERMISSIVE_CAPABILITY_PROFILE.text,
        maxLength: 4096,
        encoding: "characters",
        markdownDialect: "plain",
      },
    };
    const { outboundAttachments: _outboundAttachments, ...textOnlyProfile } =
      textOnlyProfileWithUndefinedOutbound;

    const intent = buildArtifactDeliveryIntent({
      artifact: {
        kind: "plan",
        title: "Plan artifact",
        markdown: longMarkdown(),
      },
      capabilityProfile: textOnlyProfile,
      createdAt: 1000,
      id: "plan-fallback",
    });

    expect(intent.artifactDelivery.mode).toBe("inline_fallback");
    expect(intent.parts).toHaveLength(1);
    expect(intent.parts[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("Attachment delivery is unavailable"),
    });
  });

  it("falls back to inline preview when upload size exceeds the capability limit", () => {
    const tinyUploadProfile: MessagingCapabilityProfile = {
      ...PERMISSIVE_CAPABILITY_PROFILE,
      outboundAttachments: {
        ...PERMISSIVE_CAPABILITY_PROFILE.outboundAttachments!,
        maxUploadBytes: 32,
      },
    };

    const intent = buildArtifactDeliveryIntent({
      artifact: {
        kind: "plan",
        title: "Plan artifact",
        markdown: longMarkdown(),
      },
      capabilityProfile: tinyUploadProfile,
      createdAt: 1000,
      id: "plan-too-large",
    });

    expect(intent.artifactDelivery.mode).toBe("inline_fallback");
    expect(intent.parts.every((part) => part.type !== "file")).toBe(true);
  });
});

function longMarkdown(): string {
  return [
    "# Artifact",
    "",
    ...Array.from(
      { length: 120 },
      (_, index) =>
        `- Item ${index + 1}: ${"Detailed artifact content ".repeat(4)}`,
    ),
  ].join("\n");
}
