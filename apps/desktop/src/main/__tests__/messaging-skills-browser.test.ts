import { describe, expect, it } from "vitest";
import type {
  MessagingBindingRecord,
  MessagingCapabilityProfile,
} from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import {
  buildSkillsBrowserIntent,
  filterSkillEntries,
} from "../messaging/core/messaging-skills-browser";

const binding: MessagingBindingRecord = {
  id: "binding-1",
  channel: {
    channel: "telegram",
    conversation: {
      id: "chat-1",
      kind: "dm",
    },
  },
  backend: "codex",
  threadId: "thread-1",
  authorizedActorIds: ["user-1"],
  createdAt: 1000,
  updatedAt: 1000,
};

const tightProfile: MessagingCapabilityProfile = {
  ...PERMISSIVE_CAPABILITY_PROFILE,
  actions: {
    ...PERMISSIVE_CAPABILITY_PROFILE.actions!,
    maxActions: 3,
    maxActionsPerRow: 3,
    maxLabelLength: 32,
  },
};

describe("messaging skills browser", () => {
  it("keeps a selectable skill under tight action budgets", () => {
    const intent = buildSkillsBrowserIntent({
      binding,
      capabilityProfile: tightProfile,
      createdAt: 1000,
      entries: [
        {
          name: "ce:work",
          description: "Execute implementation plans",
          enabled: true,
          path: "/skills/ce-work/SKILL.md",
        },
        {
          name: "review-pr",
          description: "Review pull requests",
          enabled: true,
          path: "/skills/review-pr/SKILL.md",
        },
      ],
      id: "skills-browser-1",
    });

    expect(intent.choices.map((choice) => choice.id)).toEqual([
      "skills:select",
      "skills:search",
      "skills:cancel",
    ]);
    expect(intent.choices[0]).toMatchObject({
      fallbackText: "1",
      label: "1. $ce:work",
    });
    expect(intent.delivery).toMatchObject({
      mode: "present",
      fallback: "present_new",
    });
    expect(intent).not.toHaveProperty("targetSurface");
  });

  it("updates the active skills workflow surface when one is provided", () => {
    const intent = buildSkillsBrowserIntent({
      binding,
      createdAt: 1000,
      entries: [],
      id: "skills-browser-1",
      targetSurface: {
        channel: "telegram",
        id: "skills-surface",
        state: { opaque: { messageId: "123" } },
      },
    });

    expect(intent.delivery).toMatchObject({
      mode: "update",
      fallback: "present_new",
      replaceMarkup: true,
    });
    expect(intent.targetSurface).toMatchObject({
      id: "skills-surface",
    });
  });

  it("keeps fallback text to choices and reply instructions", () => {
    const intent = buildSkillsBrowserIntent({
      binding,
      createdAt: 1000,
      entries: [
        {
          name: "ce:work",
          description: "Execute implementation plans",
          enabled: true,
          path: "/skills/ce-work/SKILL.md",
        },
      ],
      id: "skills-browser-1",
    });

    expect(intent.prompt).toBe("Skills");
    expect(intent.fallbackText).toBe([
      "1. $ce:work - Execute implementation plans",
      "Reply with a number, Search, Back, Next, Prev, or Cancel.",
    ].join("\n"));
  });

  it("ranks name matches before description matches while preserving source order", () => {
    const results = filterSkillEntries(
      [
        {
          name: "alpha",
          description: "Run work plans",
          enabled: true,
        },
        {
          name: "workbench",
          description: "Utilities",
          enabled: true,
        },
        {
          name: "team-work",
          description: "Collaboration",
          enabled: true,
        },
      ],
      "work",
    );

    expect(results.map((entry) => entry.name)).toEqual([
      "workbench",
      "team-work",
      "alpha",
    ]);
  });

  it("treats a leading dollar sign as skill mention syntax during search", () => {
    const results = filterSkillEntries(
      [
        {
          name: "ce:plan",
          description: "Create implementation plans",
          enabled: true,
        },
        {
          name: "ce:work",
          description: "Execute implementation plans",
          enabled: true,
        },
        {
          name: "review-pr",
          description: "Review pull requests",
          enabled: true,
        },
      ],
      "$ce:",
    );

    expect(results.map((entry) => entry.name)).toEqual(["ce:plan", "ce:work"]);
  });

  it("keeps empty-result fallback from repeating the prompt", () => {
    const intent = buildSkillsBrowserIntent({
      binding,
      createdAt: 1000,
      entries: [
        {
          name: "ce:work",
          description: "Execute implementation plans",
          enabled: true,
        },
      ],
      id: "skills-browser-1",
      query: "missing",
    });

    expect(intent.prompt).toBe('Skills matching "missing"\nNo skills matched.');
    expect(intent.fallbackText).toBe([
      "No skills matched.",
      "Reply Back, Search, or Cancel.",
    ].join("\n"));
  });
});
