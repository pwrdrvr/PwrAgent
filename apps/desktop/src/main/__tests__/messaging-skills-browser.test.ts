import { describe, expect, it } from "vitest";
import type {
  MessagingBindingRecord,
  MessagingCapabilityProfile,
} from "@pwragent/messaging-interface";
import { PERMISSIVE_CAPABILITY_PROFILE } from "@pwragent/messaging-interface/testing";
import {
  buildSkillsBrowserIntent,
  filterSkillEntries,
  flattenSkillEntries,
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

  describe("same-named skills across linked projects", () => {
    const directories = [
      { label: "PwrSnap", path: "/repo/PwrSnap" },
      { label: "PwrAgnt", path: "/repo/PwrAgnt" },
    ];
    const personal = {
      name: "slidev",
      description: "Slide decks",
      path: "/home/fixture/.agents/skills/slidev/SKILL.md",
      scope: "user",
      enabled: true,
    };
    // Codex answers per cwd and repeats personal skills under every one.
    const data = [
      {
        cwd: "/repo/PwrSnap",
        skills: [
          {
            name: "release",
            description: "Release PwrSnap",
            path: "/repo/PwrSnap/.agents/skills/release/SKILL.md",
            scope: "repo",
            enabled: true,
          },
          personal,
        ],
      },
      {
        cwd: "/repo/PwrAgnt",
        skills: [
          {
            name: "release",
            description: "Release PwrAgent",
            path: "/repo/PwrAgnt/.agents/skills/release/SKILL.md",
            scope: "repo",
            enabled: true,
          },
          personal,
        ],
      },
    ];

    it("keeps one entry per skill file, projects first", () => {
      const entries = flattenSkillEntries(data, directories);

      // Deduping by name kept PwrSnap's `release` and dropped PwrAgnt's.
      expect(entries.map((entry) => [entry.name, entry.origin?.label, entry.cwd])).toEqual([
        ["release", "PwrSnap", "/repo/PwrSnap"],
        ["release", "PwrAgnt", "/repo/PwrAgnt"],
        ["slidev", "Personal", "/repo/PwrSnap"],
      ]);
    });

    it("qualifies only the names that more than one skill shares", () => {
      const intent = buildSkillsBrowserIntent({
        binding,
        createdAt: 1000,
        entries: flattenSkillEntries(data, directories),
        id: "skills-browser-1",
      });

      expect(
        intent.choices
          .filter((choice) => choice.id === "skills:select")
          .map((choice) => [choice.label, (choice.value as { path?: string }).path]),
      ).toEqual([
        ["1. $release · PwrSnap", "/repo/PwrSnap/.agents/skills/release/SKILL.md"],
        ["2. $release · PwrAgnt", "/repo/PwrAgnt/.agents/skills/release/SKILL.md"],
        ["3. $slidev", "/home/fixture/.agents/skills/slidev/SKILL.md"],
      ]);
      expect(intent.fallbackText).toBe([
        "1. $release · PwrSnap - Release PwrSnap",
        "2. $release · PwrAgnt - Release PwrAgent",
        "3. $slidev - Slide decks",
        "Reply with a number, Search, Back, Next, Prev, or Cancel.",
      ].join("\n"));
    });

    it("keeps a row's qualifier when search narrows the list to one twin", () => {
      const intent = buildSkillsBrowserIntent({
        binding,
        createdAt: 1000,
        entries: flattenSkillEntries(data, directories),
        id: "skills-browser-1",
        query: "pwragnt",
      });

      expect(
        intent.choices
          .filter((choice) => choice.id === "skills:select")
          .map((choice) => choice.label),
      ).toEqual(["1. $release · PwrAgnt"]);
    });
  });
});
