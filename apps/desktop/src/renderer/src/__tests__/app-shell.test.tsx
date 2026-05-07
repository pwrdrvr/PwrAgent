import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import type {
  DesktopSettingsSnapshot,
  StartTurnRequest,
  StartTurnResponse,
} from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

describe("App", () => {
  afterEach(() => {
    cleanup();
  });

  it("blocks the app shell when desktop settings config is malformed", async () => {
    const listBackends = vi.fn(async () => ({
      fetchedAt: Date.now(),
      backends: [],
    }));
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: [],
      threads: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const snapshot = {
      fetchedAt: 1,
      configPath: "/tmp/pwragent/config.toml",
      configError: "line 3: expected a key",
      runtime: {
        messaging: {
          disabled: false,
        },
      },
      secretStorage: {
        available: true,
        backend: "memory",
        encrypted: false,
      },
      experimental: {
        chatReplyComposer: {
          value: "tiptap-wysiwyg-markdown-chips",
          source: "default",
        },
        diffCondensation: {
          enabled: { value: false, source: "default" },
          model: { value: "auto", source: "default" },
        },
      },
      messaging: {
        inputDebounceMs: { value: 500, source: "default" },
        toolUpdateMode: { value: "show_some", source: "default" },
        telegram: {
          enabled: { value: false, source: "default" },
          streamingResponses: { value: false, source: "default" },
          botToken: { configured: false, source: "unset", writable: true },
          authorizedUserIds: { value: [], source: "default" },
          authorizedSupergroups: { value: [], source: "default" },
        },
        discord: {
          enabled: { value: false, source: "default" },
          streamingResponses: { value: false, source: "default" },
          botToken: { configured: false, source: "unset", writable: true },
          applicationId: { value: "", source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedGuilds: { value: [], source: "default" },
        },
        mattermost: {
          enabled: { value: false, source: "default" },
          streamingResponses: { value: false, source: "default" },
          botToken: { configured: false, source: "unset", writable: true },
          hmacSecret: { configured: false, source: "unset", writable: true },
          serverUrl: { value: "", source: "default" },
          callbackBaseUrl: { value: "", source: "default" },
          slashCommandPrefix: { value: "pwragent_", source: "default" },
          registerSlashCommands: { value: false, source: "default" },
          authorizedUserIds: { value: [], source: "default" },
        },
        attachments: {
          imageProfile: { value: "medium", source: "default" },
          maxAttachmentBytes: { value: 10485760, source: "default" },
          maxAttachmentCount: { value: 4, source: "default" },
        },
      },
      models: {
        codex: {
          path: { value: "", source: "default" },
          discovery: {
            selectedCommand: undefined,
            candidates: [],
          },
        },
        grok: {
          apiKey: { configured: false, source: "unset", writable: true },
        },
      },
      applications: {
        editors: [],
        terminals: [],
        preferredEditorId: { value: "", source: "default" },
        preferredTerminalId: { value: "", source: "default" },
      },
      worktrees: {
        storage: { value: "user-home", source: "default" },
        effectivePath: "/home/example/.pwragent/worktrees",
      },
    } satisfies DesktopSettingsSnapshot;

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        readSettings: async () => ({ snapshot }),
        listBackends,
        getNavigationSnapshot,
      },
    });

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Settings config did not load",
    );
    expect(screen.getByRole("alert")).toHaveTextContent("line 3: expected a key");
    expect(screen.queryByRole("complementary", { name: "Threads" })).not.toBeInTheDocument();
    expect(listBackends).not.toHaveBeenCalled();
    expect(getNavigationSnapshot).not.toHaveBeenCalled();
  });

  it("renders the live thread shell with transcript history", async () => {
    const copyText = vi.fn(async () => undefined);
    const listSkills = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: Date.now(),
      data: [
        {
          cwd: "/Users/huntharo/.codex/worktrees/0f38/PwrAgent",
          skills: [
            {
              name: "frontend-design",
              description: "Design and verify renderer UI work.",
              path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
              enabled: true
            }
          ]
        }
      ]
    }));
    const startTurn = vi.fn<
      (request: StartTurnRequest) => Promise<StartTurnResponse>
    >(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1"
    }));
    const interruptTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    let readThreadCalls = 0;
    let resolveRefreshRead:
      | ((value: {
          backend: "codex";
          fetchedAt: number;
          threadId: string;
          replay: {
            entries: Array<Record<string, unknown>>;
            messages: Array<Record<string, unknown>>;
            lastUserMessage?: string;
            lastAssistantMessage?: string;
            pagination: {
              supportsPagination: boolean;
              hasPreviousPage: boolean;
            };
          };
        }) => void)
      | undefined;

    const transcriptResponse = {
      backend: "codex" as const,
      fetchedAt: Date.now(),
      threadId: "thread-1",
      replay: {
        entries: [
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Open the desktop plan and build the Codex client."
          },
          {
            type: "plan",
            id: "plan-1",
            explanation: "Track the desktop transcript work in three steps.",
            steps: [
              { step: "Normalize replay", status: "pending" },
              { step: "Render plan card", status: "pending" },
              { step: "Verify with tests", status: "pending" }
            ]
          },
          {
            type: "activity",
            id: "activity-1",
            summary: "Explored 2 files, ran 1 command",
            details: [
              {
                id: "detail-1",
                kind: "read",
                label: "Read TranscriptList.tsx"
              },
              {
                id: "detail-2",
                kind: "read",
                label: "Read ThreadView.tsx"
              },
              {
                id: "detail-3",
                kind: "command",
                label: "pwd && rg --files"
              }
            ]
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "The Codex client is wired and the thread browser is live."
          }
        ],
        messages: [
          {
            id: "message-1",
            role: "user",
            text: "Open the desktop plan and build the Codex client."
          },
          {
            id: "message-2",
            role: "assistant",
            text: "The Codex client is wired and the thread browser is live."
          }
        ],
        lastUserMessage: "Open the desktop plan and build the Codex client.",
        lastAssistantMessage:
          "The Codex client is wired and the thread browser is live.",
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false
        }
      }
    };

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyText,
        getRuntimeIdentity: async () => ({
          branch: "codex/fix-thread-naming-ephemeral",
          cwd: "/Users/huntharo/pwrdrvr/PwrAgent/.worktrees/pwragent-fix-thread-naming-moioth2352",
        }),
        ping: () => "pong",
        listSkills,
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "skills/list", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            },
            {
              kind: "grok",
              label: "Grok app server",
              available: true,
              methods: ["thread/list", "thread/read"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: false
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => ({
          backend: "all",
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-1"],
          threads: [
            {
              id: "thread-1",
              title: "Build Codex client",
              titleSource: "explicit",
              summary: "Wire the app-server transport and list threads",
              source: "codex",
              executionMode: "default",
              gitBranch: "codex/build-codex-client",
              linkedDirectories: [
                {
                  id: "/Users/huntharo/pwrdrvr/PwrAgent",
                  label: "PwrAgent",
                  path: "/Users/huntharo/pwrdrvr/PwrAgent",
                  worktreePath: "/Users/huntharo/.codex/worktrees/0f38/PwrAgent",
                  kind: "worktree"
                }
              ],
              inbox: {
                inInbox: true,
                reason: "new-thread"
              },
              updatedAt: Date.now()
            }
          ]
        }),
        markThreadSeen: async () => ({
          backend: "codex",
          threadId: "thread-1",
          seenAt: Date.now()
        }),
        onWindowFocus: () => () => undefined,
        readThread: async () => {
          readThreadCalls += 1;
          if (readThreadCalls === 1) {
            return transcriptResponse;
          }

          return await new Promise((resolve) => {
            resolveRefreshRead = resolve;
          });
        },
        platform: "darwin",
        startTurn,
        interruptTurn,
        onAgentEvent: () => () => undefined,
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    expect(screen.getByRole("complementary", { name: "Threads" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Threads" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "inbox" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "recents" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New thread" })).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Build Codex client"
      })
    ).toBeInTheDocument();
    expect(screen.getAllByText("PwrAgent").length).toBeGreaterThan(0);
    expect(await screen.findByText(".worktrees/pwragent-fix-t...ng-moioth2352")).toBeInTheDocument();
    expect(screen.getByText("codex/fix-thread-naming-ephemeral")).toBeInTheDocument();
    expect(screen.getAllByText("codex/build-codex-client").length).toBeGreaterThan(0);
    expect(screen.queryByRole("heading", { level: 3, name: "Transcript" })).not.toBeInTheDocument();
    const transcript = screen.getByRole("region", { name: "Transcript" });
    await waitFor(() => {
      expect(transcript).toHaveTextContent("Open the desktop plan and build the Codex client.");
    });
    expect(transcript).toHaveTextContent(
      "The Codex client is wired and the thread browser is live."
    );
    expect(screen.getByText("0 out of 3 tasks completed")).toBeInTheDocument();
    expect(screen.getByText("Render plan card")).toBeInTheDocument();
    expect(screen.getByText("Explored 2 files, ran 1 command")).toBeInTheDocument();
    const openContextButton = screen.getByRole("button", { name: "Open context rail" });
    openContextButton.click();
    expect(
      await screen.findByRole("heading", { level: 3, name: "Linked directories" })
    ).toBeInTheDocument();
    const context = screen.getByLabelText("Thread context");
    fireEvent.click(
      within(context).getByRole("button", { name: "Copy path for PwrAgent" })
    );
    fireEvent.click(
      within(context).getByRole("button", { name: "Copy path for worktree PwrAgent" })
    );
    expect(copyText).toHaveBeenNthCalledWith(1, "/Users/huntharo/pwrdrvr/PwrAgent");
    expect(copyText).toHaveBeenNthCalledWith(2, "/Users/huntharo/.codex/worktrees/0f38/PwrAgent");
    expect(screen.getByText("Codex app server")).toBeInTheDocument();
    expect(screen.getByText("Grok app server")).toBeInTheDocument();
    expect(screen.getByText("darwin")).toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toBeEnabled();
    expect(
      screen.queryByText("This thread's backend is unavailable right now. You can keep drafting, but send is unavailable.")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    const reply = screen.getByLabelText("Reply") as HTMLTextAreaElement;
    fireEvent.change(reply, {
      target: { value: "$frontend-design what can this skill do" }
    });
    reply.setSelectionRange(reply.value.length, reply.value.length);
    fireEvent.click(reply);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
    });
    expect(startTurn.mock.calls[0]?.[0]).toMatchObject({
      backend: "codex",
      threadId: "thread-1",
      input: [
        {
          type: "text",
          text: expect.stringContaining("what can this skill do")
        }
      ]
    });
    expect(
      screen.getByText("The Codex client is wired and the thread browser is live.")
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(screen.getByRole("status").querySelector(".thinking-scanner")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(
      screen.queryByText("Thinking", {
        selector: ".composer__meta"
      })
    ).not.toBeInTheDocument();
    expect(screen.queryByText("3 messages")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(interruptTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      });
    });

    resolveRefreshRead?.(transcriptResponse);
  });

  it("loads launchpad skill autocomplete from the project directory", async () => {
    const listSkills = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: Date.now(),
      data: [
        {
          cwd: "/Users/huntharo/pwrdrvr/PwrAgent",
          skills: [
            {
              name: "frontend-design",
              description: "Design and verify renderer UI work.",
              path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
              enabled: true,
              scope: "user",
            },
            {
              name: "desktop-e2e-fixture-seeding",
              description: "Replay-backed desktop E2E fixtures.",
              path: "/Users/huntharo/pwrdrvr/PwrAgent/.agents/skills/desktop-e2e-fixture-seeding/SKILL.md",
              enabled: true,
              scope: "local",
            },
          ],
        },
      ],
    }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills,
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "skills/list", "thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true,
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            },
          ],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: [],
          threads: [],
          directories: [
            {
              key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
              kind: "directory" as const,
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
              threadKeys: [],
              needsAttentionCount: 0,
              gitStatus: {
                currentBranch: "main",
                branches: ["main", "release"],
                syncState: "in-sync" as const,
              },
              launchpad: {
                directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
                directoryKind: "directory" as const,
                directoryLabel: "PwrAgent",
                directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
                backend: "codex" as const,
                executionMode: "default" as const,
                prompt: "",
                workMode: "local" as const,
                branchName: "main",
                createdAt: 1,
                updatedAt: 1,
              },
            },
          ],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        updateDirectoryLaunchpad: async ({
          directoryKey,
          patch,
        }: {
          directoryKey: string;
          patch: Record<string, unknown>;
        }) => ({
          directoryKey,
          launchpad: {
            directoryKey,
            directoryKind: "directory" as const,
            directoryLabel: "PwrAgent",
            directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: typeof patch.prompt === "string" ? patch.prompt : "",
            workMode: "local" as const,
            branchName: "main",
            createdAt: 1,
            updatedAt: 2,
          },
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        versions: {
          electron: "41.2.1",
        },
      },
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "PwrAgent",
    });

    fireEvent.change(screen.getByRole("textbox", { name: "New thread" }), {
      target: {
        value: "$front",
      },
    });

    await waitFor(() => {
      expect(listSkills).toHaveBeenCalledWith({
        backend: "codex",
        cwd: "/Users/huntharo/pwrdrvr/PwrAgent",
        cwds: ["/Users/huntharo/pwrdrvr/PwrAgent"],
      });
    });

    expect(
      await screen.findByRole("button", { name: /\$frontend-design/i })
    ).toBeInTheDocument();
  });

  it("creates and sends on a new Grok thread", async () => {
    let resolveMaterializeLaunchpad: (() => void) | undefined;
    const materializeDirectoryLaunchpad = vi.fn(
      () =>
        new Promise<{
          backend: "grok";
          threadId: string;
          executionMode: "default";
          workMode: "local";
          turnId: string;
        }>((resolve) => {
          resolveMaterializeLaunchpad = () => {
            resolve({
              backend: "grok" as const,
              threadId: "thread-2",
              executionMode: "default" as const,
              workMode: "local" as const,
              turnId: "turn-1",
            });
          };
        })
    );
    const startTurn = vi.fn(
      async ({
        backend,
        threadId
      }: {
        backend: "codex" | "grok";
        threadId: string;
      }) => ({
        backend,
        threadId,
        turnId: "turn-1"
      })
    );
    const readThread = vi.fn(
      async ({
        backend,
        threadId
      }: {
        backend: "codex" | "grok";
        threadId: string;
      }) => ({
        backend,
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false
          }
        }
      })
    );
    let launchpadState = {
      directoryKey: "workspace:new-thread",
      directoryKind: "workspace" as const,
      directoryLabel: "Workspaces",
      backend: "grok" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "local" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    let navigationCallCount = 0;

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          data: []
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: false,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            },
            {
              kind: "grok",
              label: "Grok app server",
              available: true,
              methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: false
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => {
          navigationCallCount += 1;

          if (navigationCallCount < 2) {
            return {
              backend: "all",
              fetchedAt: Date.now(),
              unchanged: false,
              inboxThreadKeys: ["codex:thread-1"],
              directories: [],
              launchpadDefaults: {
                backend: "grok",
                executionMode: "default",
              },
              threads: [
                {
                  id: "thread-1",
                  title: "Build Codex client",
                  titleSource: "explicit",
                  summary: "Wire the app-server transport and list threads",
                  source: "codex",
                  executionMode: "default",
                  gitBranch: "codex/build-codex-client",
                  linkedDirectories: [],
                  inbox: {
                    inInbox: true,
                    reason: "new-thread"
                  },
                  updatedAt: Date.now()
                }
              ]
            };
          }

          return {
            backend: "all",
            fetchedAt: Date.now(),
            unchanged: false,
            inboxThreadKeys: ["grok:thread-2"],
            directories: [],
            launchpadDefaults: {
              backend: "grok",
              executionMode: "default",
            },
            threads: [
              {
                id: "thread-2",
                title: "Investigate Grok thread",
                titleSource: "explicit",
                summary: "Start a new thread on Grok",
                source: "grok",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: true,
                  reason: "new-thread"
                },
                updatedAt: Date.now()
              },
              {
                id: "thread-1",
                title: "Build Codex client",
                titleSource: "explicit",
                summary: "Wire the app-server transport and list threads",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: false
                },
                updatedAt: Date.now() - 1000
              }
            ]
          };
        },
        markThreadSeen: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now()
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        readThread: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => {
          const userText =
            backend === "grok"
              ? "Start a Grok-backed thread from the sidebar."
              : "Open the desktop plan and build the Codex client.";
          const assistantText =
            backend === "grok"
              ? "The Grok thread is live and selected."
              : "The Codex client is wired and the thread browser is live.";

          return {
            backend,
            fetchedAt: Date.now(),
            threadId,
            replay: {
              entries: [
                {
                  type: "message",
                  id: "message-1",
                  role: "user",
                  text: userText
                },
                {
                  type: "activity",
                  id: "activity-1",
                  summary: "Explored 2 files, ran 1 command",
                  details: []
                },
                {
                  type: "message",
                  id: "message-2",
                  role: "assistant",
                  text: assistantText
                }
              ],
              messages: [
                {
                  id: "message-1",
                  role: "user",
                  text: userText
                },
                {
                  id: "message-2",
                  role: "assistant",
                  text: assistantText
                }
              ],
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false
              }
            }
          };
        },
        ensureDirectoryLaunchpad: async () => ({
          launchpad: launchpadState,
          defaults: {
            backend: "grok" as const,
            executionMode: "default" as const,
          },
        }),
        updateDirectoryLaunchpad: async ({
          directoryKey,
          patch,
        }: {
          directoryKey: string;
          patch: Record<string, unknown>;
        }) => {
          launchpadState = {
            ...launchpadState,
            ...patch,
            directoryKey,
            updatedAt: launchpadState.updatedAt + 1,
          };

          return {
            launchpad: launchpadState,
            defaults: {
              backend: "grok" as const,
              executionMode: "default" as const,
            },
          };
        },
        materializeDirectoryLaunchpad,
        startTurn,
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Build Codex client"
    });

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    const newThreadComposer = await screen.findByRole("textbox", { name: "New thread" });
    await act(async () => {
      fireEvent.change(newThreadComposer, {
        target: {
          value: "Start a Grok-backed thread from the sidebar.",
        },
      });
    });
    await waitFor(() => {
      expect(newThreadComposer).toHaveValue("Start a Grok-backed thread from the sidebar.");
    });
    const startThreadButton = screen.getByRole("button", { name: "Start thread" });
    await waitFor(() => {
      expect(startThreadButton).toBeEnabled();
    }, { timeout: 5000 });
    fireEvent.click(startThreadButton);

    expect(
      await screen.findByRole("region", { name: "Preparing transcript" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "New thread" })).not.toBeInTheDocument();

    await waitFor(() => {
      expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
        directoryKey: "workspace:new-thread",
        launchpad: expect.objectContaining({
          directoryKey: "workspace:new-thread",
        }),
        input: [
          {
            type: "text",
            text: "Start a Grok-backed thread from the sidebar.",
          },
        ],
      });
    });
    await act(async () => {
      resolveMaterializeLaunchpad?.();
    });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Investigate Grok thread" })
    ).toBeInTheDocument();
    expect(screen.getAllByText("Grok").length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Transcript" })).toHaveTextContent(
        "The Grok thread is live and selected."
      );
    });

    fireEvent.change(await screen.findByLabelText("Reply"), {
      target: {
        value: "Can you check the plugin sdk boundary?"
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(startTurn).toHaveBeenCalledWith({
      backend: "grok",
      threadId: "thread-2",
      input: [{ type: "text", text: "Can you check the plugin sdk boundary?" }],
      executionMode: "default",
      collaborationMode: undefined,
      model: undefined,
      reasoningEffort: undefined,
      serviceTier: undefined,
      fastMode: undefined,
    });
  });

  it("keeps assistant response text out of the thread header", async () => {
    const response =
      'I don\'t have a built-in "X Search" tool or direct real-time access to the X/Twitter API with the available workspace tools.';
    const summary = "Grok thread summary";

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          data: []
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "grok",
              label: "Grok app server",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: false
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => ({
          backend: "all",
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["grok:thread-1"],
          threads: [
            {
              id: "thread-1",
              title: "Use X Search to find stats on huntharo's latest tweets for me",
              titleSource: "explicit",
              summary,
              source: "grok",
              executionMode: "default",
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread"
              },
              updatedAt: Date.now()
            }
          ]
        }),
        markThreadSeen: async () => ({
          backend: "grok",
          threadId: "thread-1",
          seenAt: Date.now()
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        readThread: async () => ({
          backend: "grok",
          fetchedAt: Date.now(),
          threadId: "thread-1",
          replay: {
            entries: [
              {
                type: "message",
                id: "message-1",
                role: "user",
                text: "Use X Search to find stats on huntharo's latest tweets for me"
              },
              {
                type: "message",
                id: "message-2",
                role: "assistant",
                text: response
              }
            ],
            messages: [
              {
                id: "message-1",
                role: "user",
                text: "Use X Search to find stats on huntharo's latest tweets for me"
              },
              {
                id: "message-2",
                role: "assistant",
                text: response
              }
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false
            }
          }
        }),
        platform: "darwin",
        startTurn: async () => ({
          backend: "grok",
          threadId: "thread-1",
          turnId: "turn-1"
        }),
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Use X Search to find stats on huntharo's latest tweets for me"
      })
    ).toBeInTheDocument();

    const transcript = screen.getByRole("region", { name: "Transcript" });
    const header = document.querySelector(".thread-header");

    expect(await within(transcript).findByText(response)).toBeInTheDocument();
    expect(header).not.toBeNull();
    expect(within(header as HTMLElement).queryByText(response)).not.toBeInTheDocument();
    expect(within(header as HTMLElement).queryByText(summary)).toBeNull();
  });

  it("keeps a newly created Codex thread selected when thread/list lags behind creation", async () => {
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-new",
      executionMode: "default" as const,
      workMode: "local" as const,
      turnId: "turn-1",
    }));
    const agentEventListeners = new Set<
      (event: {
        backend: "codex" | "grok";
        notification: {
          method: string;
          params: Record<string, unknown>;
        };
      }) => void
    >();
    let navigationSnapshot: any = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-existing"],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
      threads: [
        {
          id: "thread-existing",
          title: "Existing Codex thread",
          titleSource: "explicit" as const,
          summary: "Already in the list",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const
          },
          updatedAt: Date.now()
        }
      ]
    };
    const startTurn = vi.fn(
      async ({
        backend,
        threadId
      }: {
        backend: "codex" | "grok";
        threadId: string;
      }) => ({
        backend,
        threadId,
        turnId: "turn-1"
      })
    );

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => navigationSnapshot,
        markThreadSeen: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now()
        }),
        onAgentEvent: (
          listener: (event: {
            backend: "codex" | "grok";
            notification: {
              method: string;
              params: Record<string, unknown>;
            };
          }) => void
        ) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        onWindowFocus: () => () => undefined,
        readThread: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false
            }
          }
        }),
        ensureDirectoryLaunchpad: async () => ({
          launchpad: {
            directoryKey: "workspace:new-thread",
            directoryKind: "workspace" as const,
            directoryLabel: "Workspaces",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 1,
          },
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        updateDirectoryLaunchpad: async ({
          directoryKey,
          patch,
        }: {
          directoryKey: string;
          patch: Record<string, unknown>;
        }) => ({
          launchpad: {
            directoryKey,
            directoryKind: "workspace" as const,
            directoryLabel: "Workspaces",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: typeof patch.prompt === "string" ? patch.prompt : "",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 2,
          },
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        materializeDirectoryLaunchpad,
        startTurn,
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Existing Codex thread"
    });

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "New thread" })
    ).toBeInTheDocument();

    fireEvent.change(await screen.findByRole("textbox", { name: "New thread" }), {
      target: {
        value: "hello new codex thread"
      }
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start thread" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));

    await waitFor(() => {
      expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
        directoryKey: "workspace:new-thread",
        launchpad: expect.objectContaining({
          directoryKey: "workspace:new-thread",
        }),
        input: [{ type: "text", text: "hello new codex thread" }]
      });
    });

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: {
        value: "follow up on the new codex thread"
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(startTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-new",
      input: [{ type: "text", text: "follow up on the new codex thread" }],
      executionMode: "default",
      collaborationMode: undefined,
      model: undefined,
      reasoningEffort: undefined,
      serviceTier: undefined,
      fastMode: undefined
    });

    navigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-new"],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      threads: [
        {
          id: "thread-new",
          title: "hello new codex thread",
          titleSource: "derived",
          summary: undefined,
          source: "codex",
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread"
          },
          updatedAt: Date.now()
        },
        ...navigationSnapshot.threads,
      ]
    };

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-new",
              turnId: "turn-1",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 2, name: "hello new codex thread" })
      ).toBeInTheDocument();
    });
  });

  it("applies explicit thread names from thread/name/updated notifications", async () => {
    const materializeDirectoryLaunchpad = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-new",
      executionMode: "default" as const,
      workMode: "local" as const,
      turnId: "turn-1"
    }));
    const agentEventListeners = new Set<
      (event: {
        backend: "codex" | "grok";
        notification: {
          method: string;
          params: Record<string, unknown>;
        };
      }) => void
    >();
    let navigationSnapshot: any = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-existing"],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
      threads: [
        {
          id: "thread-existing",
          title: "Existing Codex thread",
          titleSource: "explicit" as const,
          summary: "Already in the list",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const
          },
          updatedAt: Date.now()
        }
      ]
    };
    const startTurn = vi.fn(
      async ({
        backend,
        threadId
      }: {
        backend: "codex" | "grok";
        threadId: string;
      }) => ({
        backend,
        threadId,
        turnId: "turn-1"
      })
    );

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true
                }
              ]
            }
          ]
        }),
        getNavigationSnapshot: async () => navigationSnapshot,
        markThreadSeen: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now()
        }),
        onAgentEvent: (
          listener: (event: {
            backend: "codex" | "grok";
            notification: {
              method: string;
              params: Record<string, unknown>;
            };
          }) => void
        ) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        onWindowFocus: () => () => undefined,
        readThread: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false
            }
          }
        }),
        ensureDirectoryLaunchpad: async () => ({
          launchpad: {
            directoryKey: "workspace:new-thread",
            directoryKind: "workspace" as const,
            directoryLabel: "Workspaces",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: "",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 1,
          },
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        updateDirectoryLaunchpad: async ({
          directoryKey,
          patch,
        }: {
          directoryKey: string;
          patch: Record<string, unknown>;
        }) => ({
          launchpad: {
            directoryKey,
            directoryKind: "workspace" as const,
            directoryLabel: "Workspaces",
            backend: "codex" as const,
            executionMode: "default" as const,
            prompt: typeof patch.prompt === "string" ? patch.prompt : "",
            workMode: "local" as const,
            createdAt: 1,
            updatedAt: 2,
          },
          defaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        materializeDirectoryLaunchpad,
        startTurn,
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Existing Codex thread"
    });

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));

    fireEvent.change(await screen.findByRole("textbox", { name: "New thread" }), {
      target: {
        value: "Name this thread something funny and spunky. Something about potatoes."
      }
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Start thread" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "Start thread" }));

    await waitFor(() => {
      expect(materializeDirectoryLaunchpad).toHaveBeenCalledWith({
        directoryKey: "workspace:new-thread",
        launchpad: expect.objectContaining({
          directoryKey: "workspace:new-thread",
        }),
        input: [
          {
            type: "text",
            text: "Name this thread something funny and spunky. Something about potatoes."
          }
        ]
      });
    });

    navigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-new"],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
      threads: [
        {
          id: "thread-new",
          title: "Name this thread something funny and spunky. Something about potatoes.",
          titleSource: "derived",
          summary: undefined,
          source: "codex",
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread"
          },
          updatedAt: Date.now()
        }
      ]
    };

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-new",
              turnId: "turn-1",
            },
          },
        });
      }
    });

    await screen.findByRole("heading", {
      level: 2,
      name: "Name this thread something funny and spunky. Something about potatoes."
    });

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/name/updated",
            params: {
              threadId: "thread-new",
              threadName: "Spud up the thread",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 2, name: "Spud up the thread" })
      ).toBeInTheDocument();
    });
  });

  it("reuses cached thread history when reselecting an unchanged thread", async () => {
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend: "codex" | "grok";
        threadId: string;
      }) => ({
        backend,
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          messages: [
            {
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex" as const,
          fetchedAt: Date.now(),
          data: [],
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: false,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true,
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            },
          ],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-1"],
          threads: [
            {
              id: "thread-1",
              title: "First cached thread",
              titleSource: "explicit" as const,
              summary: "Cached first thread",
              source: "codex" as const,
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread" as const,
              },
              updatedAt: 1_000,
            },
            {
              id: "thread-2",
              title: "Second cached thread",
              titleSource: "explicit" as const,
              summary: "Cached second thread",
              source: "codex" as const,
              linkedDirectories: [],
              inbox: {
                inInbox: false,
              },
              updatedAt: 2_000,
            },
          ],
        }),
        markThreadSeen: async ({
          backend,
          threadId,
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now(),
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        platform: "darwin",
        readThread,
        versions: {
          electron: "41.2.1",
        },
      },
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "First cached thread",
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    expect(readThread).toHaveBeenNthCalledWith(1, {
      backend: "codex",
      threadId: "thread-1",
    });

    fireEvent.click(screen.getByRole("button", { name: /Second cached thread/i }));

    await screen.findByRole("heading", {
      level: 2,
      name: "Second cached thread",
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    expect(readThread).toHaveBeenNthCalledWith(2, {
      backend: "codex",
      threadId: "thread-2",
    });

    fireEvent.click(screen.getByRole("button", { name: /First cached thread/i }));

    await screen.findByRole("heading", {
      level: 2,
      name: "First cached thread",
    });

    expect(readThread).toHaveBeenCalledTimes(2);
  });

  it("renames the selected thread from the sidebar actions menu", async () => {
    let threadTitle = "Build Codex client";
    const renameThread = vi.fn(
      async ({ name }: { backend: "codex"; threadId: string; name: string }) => {
        threadTitle = name;
        return {
          backend: "codex" as const,
          threadId: "thread-1",
          renamedAt: Date.now(),
        };
      }
    );
    const readThread = vi.fn(async () => ({
      backend: "codex" as const,
      fetchedAt: Date.now(),
      threadId: "thread-1",
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    }));

    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        copyText: async () => undefined,
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex" as const,
          fetchedAt: Date.now(),
          data: [],
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex" as const,
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "thread/name/set"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                renameThread: true,
                readThread: true,
                startTurn: true,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true,
              },
              executionModes: [
                {
                  mode: "default" as const,
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            },
          ],
        }),
        getNavigationSnapshot: async () => ({
          backend: "all" as const,
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-1"],
          threads: [
            {
              id: "thread-1",
              title: threadTitle,
              titleSource: "explicit" as const,
              summary: "Wire the app-server transport and list threads",
              source: "codex" as const,
              executionMode: "default" as const,
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread" as const,
              },
              updatedAt: 2_000,
            },
          ],
          directories: [],
          launchpadDefaults: {
            backend: "codex" as const,
            executionMode: "default" as const,
          },
        }),
        markThreadSeen: async ({
          backend,
          threadId,
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now(),
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        platform: "darwin",
        readThread,
        renameThread,
      },
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Build Codex client",
    });

    const browseSection = screen.getByRole("region", { name: "Thread browser" });
    fireEvent.click(
      within(browseSection).getByRole("button", { name: "Open thread actions" })
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Thread" }));

    const dialog = screen.getByRole("dialog", { name: "Rename Thread" });
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Renamed Codex client" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename Thread" }));

    expect(renameThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      name: "Renamed Codex client",
    });
    await screen.findByRole("heading", {
      level: 2,
      name: "Renamed Codex client",
    });
  });
});
