import { describe, expect, it } from "vitest";
import type { NavigationSnapshot } from "@pwragent/shared";
import type {
  MessagingBrowseSessionRecord,
  MessagingCapabilityProfile,
} from "@pwragent/messaging-interface";
import {
  buildResumeIntent,
  parseResumeCommandArgs,
  RESUME_BROWSER_PAGE_SIZE,
  resumeBrowserPageSize,
} from "../messaging/core/messaging-resume-browser";

describe("messaging resume browser", () => {
  it("parses resume flags including unicode dashes and preferences", () => {
    expect(
      parseResumeCommandArgs([
        "—projects",
        "—model",
        "gpt-5.4",
        "—fast",
        "—yolo",
        "release",
        "fix",
      ]),
    ).toEqual({
      launchAction: "resume_thread",
      mode: "projects",
      query: "release fix",
      preferences: {
        executionMode: "full-access",
        fastMode: true,
        model: "gpt-5.4",
        permissionsMode: "full-access",
      },
    });
  });

  it("parses --new as new-thread project browsing", () => {
    expect(parseResumeCommandArgs(["--new"])).toEqual({
      launchAction: "start_new_thread",
      mode: "new_project",
    });
  });

  it("renders recent threads with Projects, New, and Cancel navigation", () => {
    const intent = buildResumeIntent({
      id: "intent-1",
      createdAt: 1000,
      navigation: buildNavigationSnapshot(),
      session: buildBrowseSession({
        mode: "recents",
      }),
    });

    expect(intent).toMatchObject({
      kind: "thread_picker",
      fallbackText: expect.stringContaining("Showing recent PwrAgent threads"),
      prompt: expect.stringContaining("Choose a thread to resume"),
      page: {
        actions: expect.arrayContaining([
          expect.objectContaining({ id: "browse:mode:projects" }),
          expect.objectContaining({ id: "browse:mode:new" }),
          expect.objectContaining({ id: "browse:cancel" }),
        ]),
      },
    });
    expect(intent.prompt).not.toContain("1. Thread one");
    expect(intent.fallbackText).toContain("1. Thread one");
    expect(intent.fallbackText).toContain("Reply with a number");
  });

  it("fits middle-page resume controls within LINE action budgets", () => {
    const lineProfile = buildLineLikeCapabilityProfile();
    const pageSize = resumeBrowserPageSize(lineProfile);
    const intent = buildResumeIntent({
      id: "intent-1",
      createdAt: 1000,
      navigation: buildNavigationSnapshot({
        threads: Array.from({ length: 20 }, (_, index) =>
          buildThread({
            id: `thread-${index + 1}`,
            title: `Thread ${index + 1}`,
            updatedAt: 2000 - index,
          }),
        ),
      }),
      session: buildBrowseSession({
        mode: "recents",
        pageIndex: 1,
        pageSize,
      }),
    });

    expect(pageSize).toBe(7);
    expect(intent.kind).toBe("thread_picker");
    expect(intent.page.actions).toHaveLength(lineProfile.actions!.maxActions);
    expect(intent.page.actions.map((action) => action.id)).toEqual([
      "browse:select-thread",
      "browse:select-thread",
      "browse:select-thread",
      "browse:select-thread",
      "browse:select-thread",
      "browse:select-thread",
      "browse:select-thread",
      "browse:page:prev",
      "browse:page:next",
      "browse:mode:projects",
      "browse:mode:agents",
      "browse:mode:new",
      "browse:cancel",
    ]);
  });

  it("renders project-specific thread context after selecting a project", () => {
    const intent = buildResumeIntent({
      id: "intent-1",
      createdAt: 1000,
      navigation: buildNavigationSnapshot(),
      session: buildBrowseSession({
        mode: "project_threads",
        selectedProject: {
          directoryKey: "directory:pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    });

    expect(intent).toMatchObject({
      kind: "thread_picker",
      fallbackText: expect.stringContaining("PwrAgent"),
      page: {
        items: [
          expect.objectContaining({
            id: "thread-1",
          }),
        ],
      },
    });
  });

  it("renders only Agent threads in agent browse mode", () => {
    const intent = buildResumeIntent({
      id: "intent-1",
      createdAt: 1000,
      navigation: buildNavigationSnapshot({
        threads: [
          buildThread({ id: "ordinary-thread", title: "Ordinary thread" }),
          buildThread({
            id: "agent-thread",
            title: "Agent thread",
            updatedAt: 2000,
            agent: {
              name: "Inbox Agent",
              instructionLineCount: 1,
              instructionsTooLong: false,
              updatedAt: 1500,
            },
          }),
        ],
      }),
      session: buildBrowseSession({
        mode: "agents",
      }),
    });

    expect(intent).toMatchObject({
      kind: "thread_picker",
      fallbackText: expect.stringContaining("Showing PwrAgent Agent threads."),
      prompt: expect.stringContaining("Choose an Agent thread to attach"),
      page: {
        items: [
          expect.objectContaining({
            id: "agent-thread",
          }),
        ],
        actions: expect.arrayContaining([
          expect.objectContaining({ id: "browse:mode:recents" }),
          expect.objectContaining({
            id: "browse:mode:new",
            label: "New Agent",
          }),
          expect.objectContaining({ id: "browse:cancel" }),
        ]),
      },
    });
    expect(intent.fallbackText).toContain("Agent thread");
    expect(intent.fallbackText).not.toContain("Ordinary thread");
  });

  it("renders Grok worktree threads with the primary project label", () => {
    const intent = buildResumeIntent({
      id: "intent-1",
      createdAt: 1000,
      navigation: buildNavigationSnapshot({
        threads: [
          {
            id: "thread-eksfk3v0",
            title: "Messaging - Streaming Responses",
            titleSource: "explicit",
            source: "grok",
            projectKey:
              "/repo/pwragent/.worktrees/launchpad-pwragent-main-moohzbj1",
            linkedDirectories: [
              {
                id: "/repo/pwragent",
                kind: "worktree",
                label: "PwrAgent",
                path: "/repo/pwragent",
                worktreePath:
                  "/repo/pwragent/.worktrees/launchpad-pwragent-main-moohzbj1",
              },
            ],
            inbox: {
              inInbox: false,
            },
            updatedAt: 1000,
          },
        ],
        directories: [
          {
            key: "directory:/repo/pwragent",
            kind: "directory",
            label: "PwrAgent",
            path: "/repo/pwragent",
            threadKeys: ["grok:thread-eksfk3v0"],
            needsAttentionCount: 0,
            latestUpdatedAt: 1000,
          },
        ],
      }),
      session: buildBrowseSession({
        mode: "recents",
      }),
    });

    expect(intent.kind).toBe("thread_picker");
    expect(intent.fallbackText).toContain(
      "1. Messaging - Streaming Responses (PwrAgent)",
    );
    expect(intent.fallbackText).not.toContain(
      "launchpad-pwragent-main-moohzbj1",
    );
  });

  it("filters Grok worktree threads by the primary project selection", () => {
    const intent = buildResumeIntent({
      id: "intent-1",
      createdAt: 1000,
      navigation: buildNavigationSnapshot({
        threads: [
          {
            id: "thread-eksfk3v0",
            title: "Messaging - Streaming Responses",
            titleSource: "explicit",
            source: "grok",
            projectKey:
              "/repo/pwragent/.worktrees/launchpad-pwragent-main-moohzbj1",
            linkedDirectories: [
              {
                id: "/repo/pwragent",
                kind: "worktree",
                label: "PwrAgent",
                path: "/repo/pwragent",
                worktreePath:
                  "/repo/pwragent/.worktrees/launchpad-pwragent-main-moohzbj1",
              },
            ],
            inbox: {
              inInbox: false,
            },
            updatedAt: 1000,
          },
        ],
        directories: [
          {
            key: "directory:/repo/pwragent",
            kind: "directory",
            label: "PwrAgent",
            path: "/repo/pwragent",
            threadKeys: ["grok:thread-eksfk3v0"],
            needsAttentionCount: 0,
            latestUpdatedAt: 1000,
          },
        ],
      }),
      session: buildBrowseSession({
        mode: "project_threads",
        selectedProject: {
          directoryKey: "directory:/repo/pwragent",
          label: "PwrAgent",
          path: "/repo/pwragent",
        },
      }),
    });

    expect(intent.kind).toBe("thread_picker");
    expect(intent.fallbackText).toContain(
      "Showing recent PwrAgent threads for PwrAgent.",
    );
    expect(intent.fallbackText).toContain(
      "1. Messaging - Streaming Responses (PwrAgent)",
    );
    expect(intent.fallbackText).not.toContain(
      "launchpad-pwragent-main-moohzbj1",
    );
  });

  it("renders a new-thread project picker", () => {
    const intent = buildResumeIntent({
      id: "intent-1",
      createdAt: 1000,
      navigation: buildNavigationSnapshot(),
      session: buildBrowseSession({
        launchAction: "start_new_thread",
        mode: "new_project",
      }),
    });

    expect(intent).toMatchObject({
      kind: "project_picker",
      fallbackText: expect.stringContaining("new PwrAgent thread"),
      prompt: expect.stringContaining("Choose a project"),
      page: {
        items: [
          expect.objectContaining({
            label: "PwrAgent",
          }),
        ],
      },
    });
    expect(intent.prompt).not.toContain("1. PwrAgent");
    expect(intent.fallbackText).toContain("1. PwrAgent");
  });

  it("renders a Resume return action for new-thread pickers opened from resume", () => {
    const intent = buildResumeIntent({
      id: "intent-1",
      createdAt: 1000,
      navigation: buildNavigationSnapshot(),
      session: buildBrowseSession({
        launchAction: "start_new_thread",
        mode: "new_project",
        returnTo: {
          launchAction: "resume_thread",
          mode: "recents",
          pageIndex: 0,
        },
      }),
    });

    expect(intent).toMatchObject({
      kind: "project_picker",
      fallbackText: expect.stringContaining("resume or cancel"),
      page: {
        actions: expect.arrayContaining([
          expect.objectContaining({
            id: "browse:mode:resume",
            label: "Resume",
            fallbackText: "resume",
          }),
          expect.objectContaining({ id: "browse:cancel" }),
        ]),
      },
    });
  });
});

function buildBrowseSession(
  overrides: Partial<MessagingBrowseSessionRecord> = {},
): MessagingBrowseSessionRecord {
  return {
    id: "browse-1",
    allowedActorIds: ["user-1"],
    channel: {
      channel: "telegram",
      conversation: {
        id: "chat-1",
        kind: "dm",
      },
    },
    createdAt: 1000,
    updatedAt: 1000,
    expiresAt: 2000,
    launchAction: "resume_thread",
    mode: "recents",
    pageIndex: 0,
    pageSize: RESUME_BROWSER_PAGE_SIZE,
    ...overrides,
  };
}

function buildLineLikeCapabilityProfile(): MessagingCapabilityProfile {
  return {
    actions: {
      maxActions: 13,
      maxActionsPerRow: 4,
      maxCallbackPayloadBytes: 300,
      maxLabelLength: 20,
      supportsDisabled: false,
      supportsLayoutHints: true,
      supportsStyles: false,
    },
    text: {
      encoding: "utf8-bytes",
      markdownDialect: "plain",
      maxLength: 5000,
      supportsBold: false,
      supportsCodeBlocks: false,
      supportsItalic: false,
      supportsInlineCode: false,
      supportsLinks: false,
      supportsMessageEdit: false,
    },
  };
}

function buildNavigationSnapshot(
  overrides: Partial<NavigationSnapshot> = {},
): NavigationSnapshot {
  return {
    backend: "all",
    fetchedAt: 1000,
    unchanged: false,
    threads: [
      {
        id: "thread-1",
        title: "Thread one",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [
          {
            id: "directory:pwragent",
            kind: "local",
            label: "PwrAgent",
            path: "/repo/pwragent",
          },
        ],
        inbox: {
          inInbox: false,
        },
        updatedAt: 1000,
      },
    ],
    inboxThreadKeys: [],
    directories: [
      {
        key: "directory:pwragent",
        kind: "directory",
        label: "PwrAgent",
        path: "/repo/pwragent",
        threadKeys: ["codex:thread-1"],
        needsAttentionCount: 0,
        latestUpdatedAt: 1000,
      },
    ],
    launchpadDefaults: {
      backend: "codex",
      executionMode: "default",
    },
    ...overrides,
  };
}

function buildThread(
  overrides: Partial<NavigationSnapshot["threads"][number]> = {},
): NavigationSnapshot["threads"][number] {
  return {
    id: "thread-1",
    title: "Thread one",
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [
      {
        id: "directory:pwragent",
        kind: "local",
        label: "PwrAgent",
        path: "/repo/pwragent",
      },
    ],
    inbox: {
      inInbox: false,
    },
    updatedAt: 1000,
    ...overrides,
  };
}
