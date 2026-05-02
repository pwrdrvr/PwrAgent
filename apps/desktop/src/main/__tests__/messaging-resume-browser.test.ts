import { describe, expect, it } from "vitest";
import type { MessagingBrowseSessionRecord, NavigationSnapshot } from "@pwragnt/shared";
import {
  buildResumeIntent,
  parseResumeCommandArgs,
  RESUME_BROWSER_PAGE_SIZE,
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
      fallbackText: expect.stringContaining("Showing recent PwrAgnt threads"),
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

  it("renders project-specific thread context after selecting a project", () => {
    const intent = buildResumeIntent({
      id: "intent-1",
      createdAt: 1000,
      navigation: buildNavigationSnapshot(),
      session: buildBrowseSession({
        mode: "project_threads",
        selectedProject: {
          directoryKey: "directory:pwragnt",
          label: "PwrAgnt",
          path: "/repo/pwragnt",
        },
      }),
    });

    expect(intent).toMatchObject({
      kind: "thread_picker",
      fallbackText: expect.stringContaining("PwrAgnt"),
      page: {
        items: [
          expect.objectContaining({
            id: "thread-1",
          }),
        ],
      },
    });
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
            projectKey: "/repo/pwragnt/.worktrees/launchpad-pwragnt-main-moohzbj1",
            linkedDirectories: [
              {
                id: "/repo/pwragnt",
                kind: "worktree",
                label: "PwrAgnt",
                path: "/repo/pwragnt",
                worktreePath: "/repo/pwragnt/.worktrees/launchpad-pwragnt-main-moohzbj1",
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
            key: "directory:/repo/pwragnt",
            kind: "directory",
            label: "PwrAgnt",
            path: "/repo/pwragnt",
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
      "1. Messaging - Streaming Responses (PwrAgnt)",
    );
    expect(intent.fallbackText).not.toContain("launchpad-pwragnt-main-moohzbj1");
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
            projectKey: "/repo/pwragnt/.worktrees/launchpad-pwragnt-main-moohzbj1",
            linkedDirectories: [
              {
                id: "/repo/pwragnt",
                kind: "worktree",
                label: "PwrAgnt",
                path: "/repo/pwragnt",
                worktreePath: "/repo/pwragnt/.worktrees/launchpad-pwragnt-main-moohzbj1",
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
            key: "directory:/repo/pwragnt",
            kind: "directory",
            label: "PwrAgnt",
            path: "/repo/pwragnt",
            threadKeys: ["grok:thread-eksfk3v0"],
            needsAttentionCount: 0,
            latestUpdatedAt: 1000,
          },
        ],
      }),
      session: buildBrowseSession({
        mode: "project_threads",
        selectedProject: {
          directoryKey: "directory:/repo/pwragnt",
          label: "PwrAgnt",
          path: "/repo/pwragnt",
        },
      }),
    });

    expect(intent.kind).toBe("thread_picker");
    expect(intent.fallbackText).toContain(
      "Showing recent PwrAgnt threads for PwrAgnt.",
    );
    expect(intent.fallbackText).toContain(
      "1. Messaging - Streaming Responses (PwrAgnt)",
    );
    expect(intent.fallbackText).not.toContain("launchpad-pwragnt-main-moohzbj1");
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
      fallbackText: expect.stringContaining("new PwrAgnt thread"),
      prompt: expect.stringContaining("Choose a project"),
      page: {
        items: [
          expect.objectContaining({
            label: "PwrAgnt",
          }),
        ],
      },
    });
    expect(intent.prompt).not.toContain("1. PwrAgnt");
    expect(intent.fallbackText).toContain("1. PwrAgnt");
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
            id: "directory:pwragnt",
            kind: "local",
            label: "PwrAgnt",
            path: "/repo/pwragnt",
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
        key: "directory:pwragnt",
        kind: "directory",
        label: "PwrAgnt",
        path: "/repo/pwragnt",
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
