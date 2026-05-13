import { describe, expect, it } from "vitest";
import type {
  NavigationSnapshot,
} from "@pwragent/shared";
import type {
  MessagingBrowseSessionRecord,
} from "@pwragent/messaging-interface";
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
            projectKey: "/repo/pwragent/.worktrees/launchpad-pwragent-main-moohzbj1",
            linkedDirectories: [
              {
                id: "/repo/pwragent",
                kind: "worktree",
                label: "PwrAgent",
                path: "/repo/pwragent",
                worktreePath: "/repo/pwragent/.worktrees/launchpad-pwragent-main-moohzbj1",
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
    expect(intent.fallbackText).not.toContain("launchpad-pwragent-main-moohzbj1");
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
            projectKey: "/repo/pwragent/.worktrees/launchpad-pwragent-main-moohzbj1",
            linkedDirectories: [
              {
                id: "/repo/pwragent",
                kind: "worktree",
                label: "PwrAgent",
                path: "/repo/pwragent",
                worktreePath: "/repo/pwragent/.worktrees/launchpad-pwragent-main-moohzbj1",
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
    expect(intent.fallbackText).not.toContain("launchpad-pwragent-main-moohzbj1");
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
