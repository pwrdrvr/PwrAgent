import { describe, expect, it } from "vitest";
import {
  buildDiscordComponents,
  DISCORD_COMPONENT_CUSTOM_ID_LIMIT_BYTES,
  DISCORD_MESSAGE_CONTENT_LIMIT,
  sanitizeDiscordContent,
  splitDiscordContent,
  textForDiscordIntent,
} from "../discord-formatting";

describe("discord formatting", () => {
  it("preserves markdown while neutralizing broad mentions", () => {
    expect(
      sanitizeDiscordContent("Run `pnpm test`\n```ts\nexpect(true)\n```\n@everyone <@123> <@&456>"),
    ).toBe(
      "Run `pnpm test`\n```ts\nexpect(true)\n```\n@ everyone @user:123 @role:456",
    );
  });

  it("splits long content with continuation markers", () => {
    const chunks = splitDiscordContent("A".repeat(DISCORD_MESSAGE_CONTENT_LIMIT + 50));

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("[continued]");
    expect(chunks.every((chunk) => chunk.length <= DISCORD_MESSAGE_CONTENT_LIMIT)).toBe(
      true,
    );
  });

  it("builds button components with opaque custom IDs", () => {
    const components = buildDiscordComponents(
      [
        {
          id: "bind:codex:a-very-long-thread-identifier",
          label: "1. Thread",
          style: "primary",
        },
      ],
      () => "dc:short-handle",
    );

    expect(components).toEqual([
      {
        components: [
          {
            custom_id: "dc:short-handle",
            label: "1. Thread",
            style: 1,
            type: 2,
          },
        ],
        type: 1,
      },
    ]);
    expect(Buffer.byteLength(components![0]!.components[0]!.custom_id, "utf8")).toBeLessThanOrEqual(
      DISCORD_COMPONENT_CUSTOM_ID_LIMIT_BYTES,
    );
  });

  it("preserves approval markdown code blocks", () => {
    const rendered = textForDiscordIntent({
      id: "approval-1",
      kind: "approval",
      createdAt: 1000,
      title: "Command Approval",
      body: "Command:\n```shell\npnpm test\n```",
      decisions: [],
    });

    expect(rendered).toContain("```shell\npnpm test\n```");
  });
});
