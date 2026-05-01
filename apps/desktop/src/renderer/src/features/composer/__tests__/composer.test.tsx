import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  BackendSummary,
  NavigationLaunchpadDraft,
  StartReviewRequest,
  StartTurnRequest,
  StartTurnResponse,
} from "@pwragnt/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeImageFile } from "../../../lib/image-normalization";
import { Composer } from "../Composer";

vi.mock("../../../lib/image-normalization", () => ({
  normalizeImageFile: vi.fn(async (file: File) => ({
    conversionPath: "renderer",
    dataUrl: `data:${file.type || "image/png"};base64,AQID`,
    height: 24,
    mimeType: file.type || "image/png",
    original: {
      height: 24,
      mimeType: file.type || "image/png",
      name: file.name,
      size: file.size,
      width: 32,
    },
    size: 3,
    width: 32,
  })),
}));

afterEach(() => {
  vi.mocked(normalizeImageFile).mockClear();
  cleanup();
});

function openDropdown(label: string): HTMLElement {
  const dropdown = screen.getByLabelText(label);
  fireEvent.click(dropdown);
  return dropdown;
}

function chooseDropdownOption(label: string, optionName: string): void {
  openDropdown(label);
  fireEvent.click(screen.getByRole("option", { name: optionName }));
}

function backendSummary(
  kind: "codex" | "grok",
  launchpadOptions?: BackendSummary["launchpadOptions"],
): BackendSummary {
  return {
    kind,
    label: kind,
    available: true,
    methods: ["thread/start", "turn/start"],
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
      approvalRequests: true,
      multiDirectoryThreads: kind === "codex",
    },
    executionModes: [
      {
        mode: "default",
        label: "Default Access",
        available: true,
        isDefault: true,
      },
    ],
    launchpadOptions,
  };
}

describe("Composer", () => {
  it("opens the current workspace in discovered applications", async () => {
    const openApplication = vi.fn(async () => ({ opened: true as const }));

    render(
      <Composer
        applications={{
          editors: [
            {
              id: "vscode",
              kind: "editor",
              name: "VS Code",
              source: "application",
              appPath: "/Applications/Visual Studio Code.app",
              canOpenWorkspace: true,
            },
          ],
          terminals: [
            {
              id: "terminal",
              kind: "terminal",
              name: "Terminal",
              source: "application",
              appPath: "/System/Applications/Utilities/Terminal.app",
              canOpenWorkspace: true,
            },
            {
              id: "ghostty",
              kind: "terminal",
              name: "Ghostty",
              source: "application",
              appPath: "/Applications/Ghostty.app",
              canOpenWorkspace: true,
            },
          ],
          preferredEditorId: { value: "", source: "default" },
          preferredTerminalId: { value: "ghostty", source: "config" },
        }}
        backends={[backendSummary("codex")]}
        desktopApi={{ openApplication }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Application launch",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [
            {
              id: "directory-1",
              kind: "local",
              label: "PwrAgnt",
              path: "/repo/PwrAgnt",
            },
          ],
          inbox: { inInbox: false },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "VS Code" }));
    await waitFor(() => {
      expect(openApplication).toHaveBeenCalledWith({
        applicationId: "vscode",
        kind: "editor",
        targetPath: "/repo/PwrAgnt",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Ghostty" }));
    await waitFor(() => {
      expect(openApplication).toHaveBeenCalledWith({
        applicationId: "ghostty",
        kind: "terminal",
        targetPath: "/repo/PwrAgnt",
      });
    });
  });

  it("shows an orange moon for reported context window usage", () => {
    render(
      <Composer
        backends={[backendSummary("codex")]}
        contextWindow={{
          cachedInputTokens: 32_000,
          cumulativeTotalTokens: 80_000,
          inputTokens: 63_000,
          modelContextWindow: 128_000,
          outputTokens: 1_000,
          phase: 4,
          remainingPercent: 50,
          remainingTokens: 64_000,
          totalTokens: 64_000,
          usedPercent: 50,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Context usage",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    expect(
      screen.getByRole("img", {
        name: "Context window 50% full, 64k/128k tokens, full moon",
      })
    ).toBeInTheDocument();
    expect(screen.getByRole("img")).toHaveAttribute(
      "data-tooltip",
      [
        "Context window: 50% full (full moon)",
        "Current snapshot: 64k / 128k tokens",
        "Remaining: 64k tokens, 50% remaining",
        "Current breakdown: 63k input, 32k cached, 1k output",
        "Cumulative usage reported: 80k tokens",
      ].join("\n")
    );
    expect(screen.getByRole("img")).not.toHaveAttribute("title");
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("shows OpenAI model and reasoning defaults without a Default option", () => {
    render(
      <Composer
        backends={[
          backendSummary("codex", {
            models: [
              {
                id: "gpt-5.5",
                label: "GPT-5.5",
                current: true,
                supportsReasoning: true,
                supportsFast: true,
              },
              {
                id: "gpt-5.4",
                label: "GPT-5.4",
                supportsReasoning: true,
                supportsFast: true,
              },
            ],
            reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
            supportsFastMode: true,
          }),
        ]}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "Repo",
          directoryPath: "/repo",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        }}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );

    expect(screen.getByLabelText("Model")).toHaveValue("gpt-5.5");
    expect(screen.getByLabelText("Reasoning")).toHaveValue("medium");
    expect(screen.queryByRole("option", { name: "Default" })).not.toBeInTheDocument();
  });

  it("hides reasoning controls for Grok 4.20 models", () => {
    render(
      <Composer
        backends={[
          backendSummary("grok", {
            models: [
              {
                id: "grok-4.20-reasoning",
                label: "Grok 4.20 Reasoning",
                current: true,
                supportsReasoning: false,
              },
              {
                id: "grok-4.20-non-reasoning",
                label: "Grok 4.20 Non-Reasoning",
                supportsReasoning: false,
              },
            ],
          }),
        ]}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "Repo",
          directoryPath: "/repo",
          backend: "grok",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        }}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );

    expect(screen.getByLabelText("Model")).toHaveValue("grok-4.20-reasoning");
    expect(screen.queryByLabelText("Reasoning")).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Default" })).not.toBeInTheDocument();
  });

  it("sends effective model defaults for threads without saved model settings", async () => {
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-1",
    }));

    render(
      <Composer
        backends={[
          backendSummary("codex", {
            models: [
              {
                id: "gpt-5.5",
                label: "GPT-5.5",
                current: true,
                supportsReasoning: true,
              },
            ],
            reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
          }),
        ]}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Default model",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Use defaults" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
    });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "gpt-5.5",
        reasoningEffort: "medium",
      })
    );
  });

  it("keeps the reply input focusable while the send request is pending", async () => {
    let resolveStartTurn: ((value: StartTurnResponse) => void) | undefined;
    const startTurn = vi.fn(
      (request: StartTurnRequest) =>
        new Promise<StartTurnResponse>((resolve) => {
          resolveStartTurn = resolve;
        })
    );

    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Slow send",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Start a slow turn" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(textarea).toBeEnabled();

    await act(async () => {
      resolveStartTurn?.({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      });
    });
  });

  it("queues Enter during an active turn and sends it after the turn clears", async () => {
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-2",
    }));
    const baseProps = {
      backends: [backendSummary("codex")],
      desktopApi: {
        onAgentEvent: () => () => undefined,
        startTurn,
      },
      disabled: false,
      skills: [],
      thread: {
        id: "thread-1",
        title: "Active turn",
        titleSource: "explicit" as const,
        source: "codex" as const,
        executionMode: "default" as const,
        linkedDirectories: [],
        inbox: { inInbox: false },
      },
    };

    const { rerender } = render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Follow up next" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(startTurn).not.toHaveBeenCalled();
    expect(screen.getByText("Queued next")).toBeInTheDocument();
    expect(screen.getByText("Follow up next")).toBeInTheDocument();
    expect(textarea).toHaveValue("");

    rerender(<Composer {...baseProps} activeTurnId={undefined} />);

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-1",
          input: [{ type: "text", text: "Follow up next" }],
        })
      );
    });
  });

  it("shows queued image thumbnails while a turn is active", async () => {
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-2",
    }));
    const imageFile = new File([new Uint8Array([1, 2, 3])], "queued.png", {
      type: "image/png",
    });

    render(
      <Composer
        activeTurnId="turn-1"
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Active image turn",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.paste(screen.getByLabelText("Reply"), {
      clipboardData: {
        files: [],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    expect(await screen.findByAltText("queued.png")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Queue" }));

    expect(startTurn).not.toHaveBeenCalled();
    expect(screen.getByText("Queued next")).toBeInTheDocument();
    expect(screen.getByText("1 image")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Queued image attachments: 1")
    ).toBeInTheDocument();
    expect(screen.getByAltText("queued.png")).toBeInTheDocument();
  });

  it("steers Command Enter during an active turn when supported", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const steerTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    const startTurn = vi.fn();

    render(
      <Composer
        activeTurnId="turn-1"
        backends={[
          {
            ...backendSummary("codex", {
              models: [
                {
                  id: "gpt-5.5",
                  label: "GPT-5.5",
                  current: true,
                  supportsReasoning: true,
                  supportsSteering: true,
                },
              ],
            }),
            capabilities: {
              ...backendSummary("codex").capabilities,
              steerTurn: true,
            },
          },
        ]}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn,
          steerTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Steerable thread",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Change direction" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(steerTurn).not.toHaveBeenCalled();
    expect(screen.getByText("Pending steer")).toBeInTheDocument();
    expect(screen.getByText("Change direction")).toBeInTheDocument();
    expect(textarea).toHaveValue("");

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: {
              type: "tool_call",
              output: "ready for another instruction",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(steerTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Change direction" }],
      });
    });
    expect(screen.getByText("Steering now")).toBeInTheDocument();
    expect(startTurn).not.toHaveBeenCalled();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: {
              type: "message",
              role: "user",
              text: "Change direction",
            },
          },
        },
      });
    });

    expect(screen.queryByText("Steering now")).not.toBeInTheDocument();
  });

  it("lets pending steers be edited before they are injected", async () => {
    const steerTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));

    render(
      <Composer
        activeTurnId="turn-1"
        backends={[
          {
            ...backendSummary("codex", {
              models: [
                {
                  id: "gpt-5.5",
                  label: "GPT-5.5",
                  current: true,
                  supportsReasoning: true,
                  supportsSteering: true,
                },
              ],
            }),
            capabilities: {
              ...backendSummary("codex").capabilities,
              steerTurn: true,
            },
          },
        ]}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          steerTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Editable steer",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Revise the plan" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(screen.getByText("Pending steer")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(textarea).toHaveValue("Revise the plan");
    expect(screen.queryByText("Pending steer")).not.toBeInTheDocument();
    expect(steerTurn).not.toHaveBeenCalled();
  });

  it("does not acknowledge matching steer text before the steer is sent", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const steerTurn = vi.fn(async () => {
      throw new Error("steer failed");
    });

    render(
      <Composer
        activeTurnId="turn-1"
        backends={[
          {
            ...backendSummary("codex", {
              models: [
                {
                  id: "gpt-5.5",
                  label: "GPT-5.5",
                  current: true,
                  supportsReasoning: true,
                  supportsSteering: true,
                },
              ],
            }),
            capabilities: {
              ...backendSummary("codex").capabilities,
              steerTurn: true,
            },
          },
        ]}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          steerTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Steer race",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Change direction" },
    });
    fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter", metaKey: true });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: {
              type: "tool_call",
              output: "tool output mentioning Change direction before injection",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(steerTurn).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("Pending steer")).toBeInTheDocument();
    expect(screen.getByText("Change direction")).toBeInTheDocument();
    expect(screen.getByText("steer failed")).toBeInTheDocument();
  });

  it("restores a pending steer to the draft when turn completion leaves an existing queue", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: "turn/completed";
            params: {
              threadId: string;
              turnId: string;
              turn: {
                id: string;
                status: "completed";
              };
            };
          };
        }) => void)
      | undefined;
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-2",
    }));

    render(
      <Composer
        activeTurnId="turn-1"
        backends={[
          {
            ...backendSummary("codex", {
              models: [
                {
                  id: "gpt-5.5",
                  label: "GPT-5.5",
                  current: true,
                  supportsReasoning: true,
                  supportsSteering: true,
                },
              ],
            }),
            capabilities: {
              ...backendSummary("codex").capabilities,
              steerTurn: true,
            },
          },
        ]}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn,
          steerTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "turn-1",
          }),
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Queue and steer",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Queued follow-up" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "Pending steer draft" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(screen.getByText("Queued next")).toBeInTheDocument();
    expect(screen.getByText("Queued follow-up")).toBeInTheDocument();
    expect(screen.getByText("Pending steer")).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-1",
          input: [{ type: "text", text: "Queued follow-up" }],
        })
      );
    });
    expect(textarea).toHaveValue("Pending steer draft");
    expect(screen.queryByText("Pending steer")).not.toBeInTheDocument();
  });

  it("updates model settings without crashing when fast-mode support changes", async () => {
    const onSetThreadModelSettings = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[
          backendSummary("codex", {
            models: [
              {
                id: "gpt-5.5",
                label: "GPT-5.5",
                current: true,
                supportsReasoning: true,
                supportsFast: true,
              },
              {
                id: "gpt-5.2",
                label: "GPT-5.2",
                supportsReasoning: true,
                supportsFast: false,
              },
            ],
            reasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
            supportsFastMode: true,
          }),
        ]}
        onSetThreadModelSettings={onSetThreadModelSettings}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Model switch",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          fastMode: true,
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    expect(screen.getByText("Fast mode")).toBeInTheDocument();

    chooseDropdownOption("Model", "GPT-5.2");

    await waitFor(() => {
      expect(onSetThreadModelSettings).toHaveBeenCalledWith({
        model: "gpt-5.2",
        reasoningEffort: "medium",
        fastMode: undefined,
      });
    });
  });

  it("routes slash review to startReview instead of startTurn", async () => {
    const startTurn = vi.fn();
    const addOptimisticReviewEntry = vi.fn(() => "review-optimistic-1");
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));

    render(
      <Composer
        addOptimisticReviewEntry={addOptimisticReviewEntry}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Review thread",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review main" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      });
    });
    expect(addOptimisticReviewEntry).toHaveBeenCalledWith("Review changes against main");
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("asks for a review target before submitting bare slash review commands", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Review thread",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "codex/feature",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "/review" } });

    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();
    expect(startReview).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Base branch/i }));
    fireEvent.change(screen.getByLabelText("Base branch"), {
      target: { value: "release" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "release" },
        delivery: "inline",
      });
    });
  });

  it("submits current changes when selected from the bare review target prompt", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Review thread",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: /Current changes/i }));
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "uncommittedChanges" },
        delivery: "inline",
      });
    });
  });

  it("inserts slash review commands from autocomplete", async () => {
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "turn-1",
          }),
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Review thread",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "/r" } });

    expect(screen.getByRole("listbox", { name: "Commands" })).toHaveClass(
      "composer__autocomplete"
    );
    fireEvent.click(screen.getByRole("button", { name: /\/review/i }));

    expect(textarea).toHaveValue("/review ");
  });

  it("applies the focused slash command option from the keyboard", async () => {
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "turn-1",
          }),
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Review thread",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "/r" } });

    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(textarea).toHaveValue("/review ");
  });

  it("shows thread access in the composer and opens workspace handoff", async () => {
    const onSetExecutionMode = vi.fn(async () => undefined);
    const onHandoffThreadWorkspace = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: [],
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
        ]}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "turn-1",
          }),
        }}
        disabled={false}
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
          kind: "directory",
          label: "PwrAgnt",
          path: "/Users/huntharo/pwrdrvr/PwrAgnt",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "feat/thread-workspace-handoff-plan",
            defaultBranch: "main",
            branches: ["feat/thread-workspace-handoff-plan", "release", "main"],
            handoffBranches: ["main", "release"],
            syncState: "untracked",
          },
        }}
        onHandoffThreadWorkspace={onHandoffThreadWorkspace}
        onSetExecutionMode={onSetExecutionMode}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          gitBranch: "fix/context-rail-slide-reflow",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgnt",
              path: "/Users/huntharo/pwrdrvr/PwrAgnt",
              kind: "local",
            },
          ],
          inbox: { inInbox: false },
        }}
      />
    );

    expect(screen.getByLabelText("Access mode")).toHaveValue("default");
    fireEvent.click(screen.getByLabelText("Workspace mode"));
    expect(screen.getByRole("separator")).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByLabelText("Reply"));
    expect(
      screen.queryByRole("menuitem", { name: "Handoff to New Worktree" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Workspace mode"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Handoff to New Worktree" }));
    const dialog = screen.getByRole("dialog", { name: "Handoff to New Worktree" });
    expect(dialog).toBeInTheDocument();
    expect(dialog.closest(".workspace-handoff-modal")).toBeInTheDocument();
    expect(dialog).toHaveTextContent("feat/thread-workspace-handoff-plan");
    expect(screen.getByLabelText("Leave Local on")).toHaveValue("main");
    expect(screen.queryByRole("option", { name: "Detached HEAD" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Handoff" }));

    await waitFor(() => {
      expect(onHandoffThreadWorkspace).toHaveBeenCalledWith({
        direction: "local-to-worktree",
        repositoryPath: "/Users/huntharo/pwrdrvr/PwrAgnt",
        sourcePath: "/Users/huntharo/pwrdrvr/PwrAgnt",
        sourceBranch: "feat/thread-workspace-handoff-plan",
        leaveLocalBranch: "main",
      });
    });

    chooseDropdownOption("Access mode", "Full Access");

    await waitFor(() => {
      expect(onSetExecutionMode).toHaveBeenCalledWith("full-access");
    });
  });

  it("lets a directory launchpad switch from local checkout to a new worktree", async () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/start"],
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
            ],
          },
        ]}
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
          kind: "directory",
          label: "PwrAgnt",
          path: "/Users/huntharo/pwrdrvr/PwrAgnt",
          threadKeys: [],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "main",
            branches: ["main", "release"],
            syncState: "untracked",
          },
        }}
        launchpad={{
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
          directoryKind: "directory",
          directoryLabel: "PwrAgnt",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgnt",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        }}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );

    const workspaceMode = screen.getByLabelText("Workspace mode");
    expect(workspaceMode).toBeEnabled();
    expect(workspaceMode).toHaveValue("local");
    fireEvent.click(workspaceMode);
    expect(screen.getByRole("option", { name: "Local (main)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "New worktree" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "New worktree" }));

    await waitFor(() => {
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
        { workMode: "worktree" },
        { stickySettingsChanged: true }
      );
    });
  });

  it("renders the worktree base branch menu as a branch chooser", () => {
    render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
          kind: "directory",
          label: "PwrAgnt",
          path: "/Users/huntharo/pwrdrvr/PwrAgnt",
          threadKeys: [],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "develop",
            branches: [
              "feat/desktop-settings-config",
              "codex/plan-github-actions-rollout",
              "develop",
              "main",
            ],
            syncState: "untracked",
          },
        }}
        launchpad={{
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgnt",
          directoryKind: "directory",
          directoryLabel: "PwrAgnt",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgnt",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          branchName: "feat/desktop-settings-config",
          createdAt: 1,
          updatedAt: 1,
        }}
        skills={[]}
      />
    );

    fireEvent.click(screen.getByLabelText("Base branch"));

    expect(screen.getByRole("listbox").closest(".composer-dropdown")).toHaveClass(
      "composer-dropdown--branch"
    );
    expect(
      screen.getByRole("option", { name: "feat/desktop-settings-config" })
    ).toHaveAttribute("aria-selected", "true");
  });

  it("shows handoff to local for existing worktree threads", async () => {
    const onHandoffThreadWorkspace = vi.fn(async () => undefined);
    const openApplication = vi.fn(async () => ({ opened: true as const }));

    const { rerender } = render(
      <Composer
        applications={{
          editors: [
            {
              id: "vscode",
              kind: "editor",
              name: "VS Code",
              source: "application",
              appPath: "/Applications/Visual Studio Code.app",
              canOpenWorkspace: true,
            },
          ],
          terminals: [],
          preferredEditorId: { value: "", source: "default" },
          preferredTerminalId: { value: "", source: "default" },
        }}
        backends={[backendSummary("codex")]}
        desktopApi={{ openApplication }}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "PwrAgnt",
          path: "/repo",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
        }}
        onHandoffThreadWorkspace={onHandoffThreadWorkspace}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Worktree thread",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          gitBranch: "feature/handoff",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgnt",
              path: "/repo",
              worktreePath: "/repo/.worktrees/pwragnt-feature",
              kind: "worktree",
            },
          ],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "VS Code" }));
    await waitFor(() => {
      expect(openApplication).toHaveBeenLastCalledWith({
        applicationId: "vscode",
        kind: "editor",
        targetPath: "/repo/.worktrees/pwragnt-feature",
      });
    });

    fireEvent.click(screen.getByLabelText("Workspace mode"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Handoff to Local" }));
    expect(screen.getByRole("dialog", { name: "Handoff to Local" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Handoff" }));

    await waitFor(() => {
      expect(onHandoffThreadWorkspace).toHaveBeenCalledWith({
        direction: "worktree-to-local",
        repositoryPath: "/repo",
        sourcePath: "/repo/.worktrees/pwragnt-feature",
        sourceBranch: "feature/handoff",
        leaveLocalBranch: undefined,
      });
    });

    rerender(
      <Composer
        applications={{
          editors: [
            {
              id: "vscode",
              kind: "editor",
              name: "VS Code",
              source: "application",
              appPath: "/Applications/Visual Studio Code.app",
              canOpenWorkspace: true,
            },
          ],
          terminals: [],
          preferredEditorId: { value: "", source: "default" },
          preferredTerminalId: { value: "", source: "default" },
        }}
        backends={[backendSummary("codex")]}
        desktopApi={{ openApplication }}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "PwrAgnt",
          path: "/repo",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
        }}
        onHandoffThreadWorkspace={onHandoffThreadWorkspace}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Worktree thread",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          gitBranch: "feature/handoff",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgnt",
              path: "/repo",
              kind: "local",
            },
          ],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "VS Code" }));
    await waitFor(() => {
      expect(openApplication).toHaveBeenLastCalledWith({
        applicationId: "vscode",
        kind: "editor",
        targetPath: "/repo",
      });
    });
  });

  it("restores pasted launchpad images after switching away and back before starting the thread", async () => {
    const launchpads = new Map<string, NavigationLaunchpadDraft>([
      [
        "directory:/repo-a",
        {
          directoryKey: "directory:/repo-a",
          directoryKind: "directory" as const,
          directoryLabel: "Repo A",
          directoryPath: "/repo-a",
          backend: "codex" as const,
          executionMode: "default" as const,
          prompt: "",
          workMode: "local" as const,
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        "directory:/repo-b",
        {
          directoryKey: "directory:/repo-b",
          directoryKind: "directory" as const,
          directoryLabel: "Repo B",
          directoryPath: "/repo-b",
          backend: "codex" as const,
          executionMode: "default" as const,
          prompt: "",
          workMode: "local" as const,
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);
    const onUpdateLaunchpad = vi.fn(async (directoryKey, patch) => {
      const current = launchpads.get(directoryKey);
      if (!current) {
        throw new Error(`Unknown launchpad ${directoryKey}`);
      }
      launchpads.set(directoryKey, {
        ...current,
        ...patch,
        updatedAt: current.updatedAt + 1,
      });
    });
    const imageFile = new File([new Uint8Array([1, 2, 3])], "mockup.png", {
      type: "image/png",
    });

    const { rerender } = render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/repo-a",
          kind: "directory",
          label: "Repo A",
          path: "/repo-a",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={launchpads.get("directory:/repo-a")!}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );

    fireEvent.change(screen.getByLabelText("New thread"), {
      target: { value: "Review the pasted mockup" },
    });
    fireEvent.paste(screen.getByLabelText("New thread"), {
      clipboardData: {
        files: [],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    expect(await screen.findByAltText("mockup.png")).toBeInTheDocument();

    await waitFor(() => {
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/repo-a",
        expect.objectContaining({
          imageAttachments: expect.arrayContaining([
            expect.objectContaining({ name: "mockup.png" }),
          ]),
          prompt: "Review the pasted mockup",
        })
      );
    });

    await waitFor(() => {
      expect(launchpads.get("directory:/repo-a")?.prompt).toBe(
        "Review the pasted mockup"
      );
    });

    rerender(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/repo-b",
          kind: "directory",
          label: "Repo B",
          path: "/repo-b",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={launchpads.get("directory:/repo-b")!}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );
    expect(screen.queryByAltText("mockup.png")).not.toBeInTheDocument();

    rerender(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/repo-a",
          kind: "directory",
          label: "Repo A",
          path: "/repo-a",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={launchpads.get("directory:/repo-a")!}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );

    expect(screen.getByLabelText("New thread")).toHaveValue(
      "Review the pasted mockup"
    );
    expect(screen.getByAltText("mockup.png")).toBeInTheDocument();
  });

  it("persists launchpad pasted images that finish after switching away", async () => {
    let resolveNormalization: (file: File) => void = () => undefined;
    vi.mocked(normalizeImageFile).mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveNormalization = (file: File) => {
            resolve({
              conversionPath: "renderer",
              dataUrl: "data:image/png;base64,AQID",
              height: 24,
              mimeType: "image/png",
              original: {
                height: 24,
                mimeType: file.type || "image/png",
                name: file.name,
                size: file.size,
                width: 32,
              },
              size: 3,
              width: 32,
            });
          };
        })
    );

    const launchpads = new Map<string, NavigationLaunchpadDraft>([
      [
        "directory:/repo-a",
        {
          directoryKey: "directory:/repo-a",
          directoryKind: "directory",
          directoryLabel: "Repo A",
          directoryPath: "/repo-a",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      [
        "directory:/repo-b",
        {
          directoryKey: "directory:/repo-b",
          directoryKind: "directory",
          directoryLabel: "Repo B",
          directoryPath: "/repo-b",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    ]);
    const onUpdateLaunchpad = vi.fn(async (directoryKey, patch) => {
      const current = launchpads.get(directoryKey);
      if (!current) {
        throw new Error(`Unknown launchpad ${directoryKey}`);
      }
      launchpads.set(directoryKey, {
        ...current,
        ...patch,
        updatedAt: current.updatedAt + 1,
      });
    });
    const imageFile = new File([new Uint8Array([1, 2, 3])], "slow-mockup.png", {
      type: "image/png",
    });

    const { rerender } = render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/repo-a",
          kind: "directory",
          label: "Repo A",
          path: "/repo-a",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={launchpads.get("directory:/repo-a")!}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );

    fireEvent.change(screen.getByLabelText("New thread"), {
      target: { value: "Review the slow mockup" },
    });
    fireEvent.paste(screen.getByLabelText("New thread"), {
      clipboardData: {
        files: [],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    rerender(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/repo-b",
          kind: "directory",
          label: "Repo B",
          path: "/repo-b",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={launchpads.get("directory:/repo-b")!}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );

    await act(async () => {
      resolveNormalization(imageFile);
    });

    await waitFor(() => {
      expect(launchpads.get("directory:/repo-a")?.imageAttachments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "slow-mockup.png" }),
        ])
      );
    });
    expect(launchpads.get("directory:/repo-a")?.prompt).toBe(
      "Review the slow mockup"
    );

    rerender(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/repo-a",
          kind: "directory",
          label: "Repo A",
          path: "/repo-a",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={launchpads.get("directory:/repo-a")!}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );

    expect(screen.getByLabelText("New thread")).toHaveValue(
      "Review the slow mockup"
    );
    expect(screen.getByAltText("slow-mockup.png")).toBeInTheDocument();
  });

  it("keeps active launchpad edits stable when an autosave rerenders the same draft", () => {
    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/repo",
      directoryKind: "directory",
      directoryLabel: "Repo",
      directoryPath: "/repo",
      backend: "codex",
      executionMode: "default",
      prompt: "Line one\nLine two",
      workMode: "local",
      branchName: "main",
      createdAt: 1,
      updatedAt: 1,
    };
    const { rerender } = render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "Repo",
          path: "/repo",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={launchpad}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );
    const textarea = screen.getByLabelText("New thread") as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "Line one edited\nLine two" } });
    textarea.setSelectionRange(8, 8);
    rerender(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "Repo",
          path: "/repo",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={{
          ...launchpad,
          updatedAt: 2,
        }}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );

    expect(textarea).toHaveValue("Line one edited\nLine two");
    expect(textarea.selectionStart).toBe(8);
  });

  it("inserts skill markdown from autocomplete and sends it through startTurn", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            enabled: true,
          },
        ]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Use $fr" } });

    expect(screen.getByRole("listbox", { name: "Skills" })).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(screen.getAllByText("$frontend-design").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Reply")).toHaveValue("Use $frontend-design ");

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "Use [$frontend-design](/Users/huntharo/.codex/skills/frontend-design/SKILL.md)",
          },
        ],
      });
    });
  });

  it("sends the reply when Enter is pressed without Shift", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Ship it" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [{ type: "text", text: "Ship it" }],
      });
    });
  });

  it("sends pasted images with the reply", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    const addOptimisticUserMessage = vi.fn(() => "optimistic-1");
    const recordImageUploadNormalization = vi.fn(async () => undefined);
    const imageFile = new File([new Uint8Array([1, 2, 3])], "screenshot.jpeg", {
      type: "image/jpeg",
    });

    render(
      <Composer
        addOptimisticUserMessage={addOptimisticUserMessage}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          recordImageUploadNormalization,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.paste(textarea, {
      clipboardData: {
        files: [],
        items: [
          {
            kind: "file",
            type: "image/jpeg",
            getAsFile: () => imageFile,
          },
        ],
      },
    });
    fireEvent.change(textarea, { target: { value: "Describe this screenshot" } });

    expect(await screen.findByAltText("screenshot.jpeg")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          { type: "text", text: "Describe this screenshot" },
          {
            type: "image",
            url: expect.stringMatching(/^data:image\/jpeg;base64,/),
          },
        ],
      });
    });
    expect(addOptimisticUserMessage).toHaveBeenCalledWith(
      "Describe this screenshot",
      [
        {
          type: "image",
          url: expect.stringMatching(/^data:image\/jpeg;base64,/),
          alt: "screenshot.jpeg",
        },
      ]
    );
    expect(recordImageUploadNormalization).toHaveBeenCalledWith({
      fileName: "screenshot.jpeg",
      original: {
        height: 24,
        mimeType: "image/jpeg",
        size: 3,
        width: 32,
      },
      normalized: {
        height: 24,
        mimeType: "image/jpeg",
        size: 3,
        width: 32,
      },
      path: "renderer",
      resized: false,
    });
  });

  it("allows pasted image-only replies", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    const imageFile = new File([new Uint8Array([1, 2, 3])], "diagram.png");

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    fireEvent.paste(screen.getByLabelText("Reply"), {
      clipboardData: {
        files: [],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => imageFile,
          },
        ],
      },
    });

    expect(await screen.findByAltText("diagram.png")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          {
            type: "image",
            url: expect.stringMatching(/^data:image\/png;base64,/),
          },
        ],
      });
    });
  });

  it("keeps dropped GIF images animated by preserving the original data URL", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    const gifFile = new File([new Uint8Array([71, 73, 70, 56])], "demo.gif", {
      type: "image/gif",
    });

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.drop(textarea, {
      dataTransfer: {
        files: [],
        items: [
          {
            kind: "file",
            type: "image/gif",
            getAsFile: () => gifFile,
          },
        ],
      },
    });

    const preview = await screen.findByAltText("demo.gif");
    expect(preview).toHaveAttribute("src", expect.stringMatching(/^data:image\/gif;base64,/));
    expect(normalizeImageFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          {
            type: "image",
            url: expect.stringMatching(/^data:image\/gif;base64,/),
          },
        ],
      });
    });
  });

  it("does not duplicate a pasted image when clipboard items and files both expose it", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    const itemImageFile = new File([new Uint8Array([1, 2, 3])], "clipboard-item.png", {
      type: "image/png",
      lastModified: 111,
    });
    const filesImageFile = new File([new Uint8Array([1, 2, 3])], "clipboard-files.png", {
      type: "image/png",
      lastModified: 222,
    });

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.paste(screen.getByLabelText("Reply"), {
      clipboardData: {
        files: [filesImageFile],
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => itemImageFile,
          },
        ],
      },
    });

    await waitFor(() => {
      expect(screen.getAllByRole("img")).toHaveLength(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          {
            type: "image",
            url: expect.stringMatching(/^data:image\/png;base64,/),
          },
        ],
      });
    });
  });

  it("keeps Shift+Enter available for a newline", () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Line one" } });

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });

    const defaultWasPrevented = !textarea.dispatchEvent(event);

    expect(defaultWasPrevented).toBe(false);
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("applies the focused skill option when activated from the keyboard", async () => {
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "turn-1",
          }),
        }}
        disabled={false}
        skills={[
          {
            name: "ce:plan",
            description: "Turn feature descriptions into implementation plans.",
            path: "/Users/huntharo/.codex/skills/ce-plan/SKILL.md",
            enabled: true,
          },
        ]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "$ce:pl" } });

    const option = screen.getByRole("button", { name: /\$ce:plan/i });
    option.focus();
    fireEvent.click(option);

    expect(screen.getByLabelText("Reply")).toHaveValue("$ce:plan ");
  });

  it("shows a stop button for an active turn and interrupts it", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: "turn/cancelled";
            params: {
              threadId: string;
              turnId: string;
              turn: {
                id: string;
                status: "cancelled";
              };
            };
          };
        }) => void)
      | undefined;
    const interruptTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));

    render(
      <Composer
        desktopApi={{
          interruptTurn,
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "turn-1",
          }),
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "stop this turn if needed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(interruptTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      });
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/cancelled",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "cancelled",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    });
  });

  it("updates the stop target when turn/started provides the real turn id", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification:
            | {
                method: "turn/started";
                params: {
                  threadId: string;
                  turn: {
                    id: string;
                    status: string;
                  };
                };
              }
            | {
                method: "thread/status/changed";
                params: {
                  threadId: string;
                  status: {
                    type: string;
                  };
                };
              }
            | {
                method: "turn/completed";
                params: {
                  threadId: string;
                  turnId: string;
                  turn: {
                    id: string;
                    status: "completed";
                    output: Array<{ type: "text"; text: string }>;
                  };
                };
              };
        }) => void)
      | undefined;
    const interruptTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-99",
    }));
    render(
      <Composer
        desktopApi={{
          interruptTurn,
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "pending:thread-1",
          }),
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "send then stop" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-99",
              status: "inProgress",
            },
          },
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(interruptTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-99",
      });
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-99",
            turn: {
              id: "turn-99",
              status: "completed",
              output: [],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    });
  });

  it("keeps the stop button visible when idle status arrives before completion", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification:
            | {
                method: "turn/started";
                params: {
                  threadId: string;
                  turn: {
                    id: string;
                    status: string;
                  };
                };
              }
            | {
                method: "thread/status/changed";
                params: {
                  threadId: string;
                  status: {
                    type: string;
                  };
                };
              };
        }) => void)
      | undefined;
    const onPendingStatusChange = vi.fn();

    render(
      <Composer
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "pending:thread-1",
          }),
        }}
        disabled={false}
        onActiveTurnIdChange={() => undefined}
        onPendingStatusChange={onPendingStatusChange}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "send then keep thinking" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-99",
              status: "inProgress",
            },
          },
        },
      });
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: {
              type: "idle",
            },
          },
        },
      });
    });

    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(onPendingStatusChange).not.toHaveBeenCalledWith(undefined);
  });

  it("sends Codex turns with plan collaboration mode when plan mode is enabled", async () => {
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-1",
    }));
    const onPendingStatusChange = vi.fn();

    render(
      <Composer
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/read", "turn/start"],
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
              approvalRequests: true,
              multiDirectoryThreads: true,
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: true,
                isDefault: true,
              },
            ],
          },
        ]}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        onPendingStatusChange={onPendingStatusChange}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Plan mode",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Plan this change" },
    });
    fireEvent.click(screen.getByLabelText("Plan mode"));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
    });
    expect(startTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Plan this change" }],
      collaborationMode: {
        mode: "plan",
        settings: {
          developerInstructions: null,
        },
      },
    });
    expect(onPendingStatusChange).toHaveBeenCalledWith("Planning");
    await waitFor(() => {
      expect(screen.getByLabelText("Plan mode")).not.toBeChecked();
    });
  });
});
