import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, useState, type ComponentProps } from "react";
import {
  applyNavigationLaunchpadProviderSettingsPatch,
  type BackendSummary,
  type CompactThreadRequest,
  type ComposerDraftRecoveryCandidate,
  type CreateScheduledThreadActionRequest,
  type NavigationDirectorySummary,
  type NavigationThreadSummary,
  type NavigationLaunchpadDraft,
  type StartReviewRequest,
  type StartTurnRequest,
  type StartTurnResponse,
  type ScheduledThreadAction,
  type ScheduledThreadActionIdRequest,
  type SteerTurnRequest,
} from "@pwragent/shared";
import type { JSONContent } from "@tiptap/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import {
  AGENT_THREAD_CAPABILITIES,
  CODEX_AGENT_THREAD_CREATION_NOTE,
  DEFAULT_DESKTOP_AGENT_THREAD,
} from "../../../lib/agent-thread";
import { normalizeImageFile } from "../../../lib/image-normalization";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { Composer } from "../Composer";
import type {
  ComposerDraftSnapshot,
  ComposerDraftStore,
  ComposerPendingSteerSnapshot,
  ComposerQueuedTurnSnapshot,
} from "../useComposerDraftStore";

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

beforeAll(() => {
  const emptyRect = {
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    toJSON: () => ({}),
    top: 0,
    width: 0,
    x: 0,
    y: 0,
  } as DOMRect;
  const textPrototype = Text.prototype as Text & {
    getClientRects?: () => DOMRect[];
    getBoundingClientRect?: () => DOMRect;
  };
  textPrototype.getClientRects ??= () => [];
  textPrototype.getBoundingClientRect ??= () => emptyRect;
  Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect ??= () => emptyRect;
});

async function flushReactUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

afterEach(async () => {
  delete (window as unknown as {
    __pwragentFederationTarget?: unknown;
  }).__pwragentFederationTarget;
  vi.useRealTimers();
  await flushReactUpdates();
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

async function clickButton(name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function createComposerDraftStore(): ComposerDraftStore {
  const drafts = new Map<string, ComposerDraftSnapshot>();
  const draftStacks = new Map<string, ComposerDraftSnapshot[]>();
  const pendingSteers = new Map<string, ComposerPendingSteerSnapshot>();
  const queuedTurns = new Map<string, ComposerQueuedTurnSnapshot[]>();
  return {
    delete: (scopeKey) => {
      drafts.delete(scopeKey);
    },
    get: (scopeKey) => drafts.get(scopeKey),
    popDraft: (scopeKey) => {
      const current = draftStacks.get(scopeKey) ?? [];
      const restored = current.at(-1);
      const next = current.slice(0, -1);
      if (next.length > 0) {
        draftStacks.set(scopeKey, next);
      } else {
        draftStacks.delete(scopeKey);
      }
      return restored;
    },
    pushDraft: (scopeKey, snapshot) => {
      draftStacks.set(scopeKey, [...(draftStacks.get(scopeKey) ?? []), snapshot]);
    },
    deletePendingSteer: (scopeKey) => {
      pendingSteers.delete(scopeKey);
    },
    deleteQueuedTurn: (scopeKey) => {
      queuedTurns.delete(scopeKey);
    },
    getPendingSteer: (scopeKey) => pendingSteers.get(scopeKey),
    getQueuedTurn: (scopeKey) => queuedTurns.get(scopeKey)?.[0],
    getQueuedTurns: (scopeKey) => queuedTurns.get(scopeKey) ?? [],
    getQueuedTurnVersion: () => 0,
    subscribeQueuedTurns: () => () => {},
    removeQueuedTurnAt: (scopeKey, index) => {
      const current = queuedTurns.get(scopeKey) ?? [];
      const next = [...current];
      const [removed] = next.splice(index, 1);
      if (next.length > 0) {
        queuedTurns.set(scopeKey, next);
      } else {
        queuedTurns.delete(scopeKey);
      }
      return removed;
    },
    removeQueuedTurnById: (scopeKey, id) => {
      const current = queuedTurns.get(scopeKey) ?? [];
      const index = current.findIndex((entry) => entry.id === id);
      if (index === -1) {
        return undefined;
      }
      const next = [...current];
      const [removed] = next.splice(index, 1);
      if (next.length > 0) {
        queuedTurns.set(scopeKey, next);
      } else {
        queuedTurns.delete(scopeKey);
      }
      return removed;
    },
    shiftQueuedTurn: (scopeKey) => {
      const current = queuedTurns.get(scopeKey) ?? [];
      const [first, ...rest] = current;
      if (rest.length > 0) {
        queuedTurns.set(scopeKey, rest);
      } else {
        queuedTurns.delete(scopeKey);
      }
      return first;
    },
    setPendingSteer: (scopeKey, snapshot) => {
      pendingSteers.set(scopeKey, snapshot);
    },
    setQueuedTurn: (scopeKey, snapshot) => {
      queuedTurns.set(scopeKey, [snapshot]);
    },
    setQueuedTurns: (scopeKey, snapshots) => {
      if (snapshots.length > 0) {
        queuedTurns.set(scopeKey, snapshots);
      } else {
        queuedTurns.delete(scopeKey);
      }
    },
    set: (scopeKey, snapshot) => {
      drafts.set(scopeKey, snapshot);
    },
  };
}

function backendSummary(
  kind: BackendSummary["kind"],
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

const retargetingPwrSnap: NavigationDirectorySummary = {
  key: "directory:/repo/PwrSnap",
  kind: "directory",
  label: "PwrSnap",
  path: "/repo/PwrSnap",
  threadKeys: [],
  needsAttentionCount: 0,
  latestUpdatedAt: 2,
};

const retargetingPwrGit: NavigationDirectorySummary = {
  key: "directory:/repo/PwrGit",
  kind: "directory",
  label: "PwrGit",
  path: "/repo/PwrGit",
  threadKeys: [],
  needsAttentionCount: 0,
  latestUpdatedAt: 1,
};

const retargetingDirectories = [retargetingPwrSnap, retargetingPwrGit];

function createRetargetingLaunchpad(
  directory: NavigationDirectorySummary,
  prompt: string,
): NavigationLaunchpadDraft {
  return {
    directoryKey: directory.key,
    directoryKind: directory.kind,
    directoryLabel: directory.label,
    directoryPath: directory.path,
    backend: "codex",
    executionMode: "default",
    prompt,
    workMode: "local",
    branchName: "main",
    createdAt: 1,
    updatedAt: 1,
  };
}

function DraftRetargetingHarness(props: {
  previousPwrGitDraft: string;
  onMaterializeLaunchpad?: ComponentProps<
    typeof Composer
  >["onMaterializeLaunchpad"];
}) {
  const [selectedDirectoryKey, setSelectedDirectoryKey] = useState(
    retargetingPwrSnap.key,
  );
  const [launchpads, setLaunchpads] = useState(
    () => new Map<string, NavigationLaunchpadDraft>([
      [
        retargetingPwrSnap.key,
        createRetargetingLaunchpad(retargetingPwrSnap, ""),
      ],
      [
        retargetingPwrGit.key,
        createRetargetingLaunchpad(
          retargetingPwrGit,
          props.previousPwrGitDraft,
        ),
      ],
    ]),
  );
  const selectedDirectory = retargetingDirectories.find(
    (directory) => directory.key === selectedDirectoryKey,
  )!;

  return (
    <>
      <button
        aria-label="Navigate to PwrSnap launchpad"
        type="button"
        onClick={() => setSelectedDirectoryKey(retargetingPwrSnap.key)}
      />
      <button
        aria-label="Navigate to PwrGit launchpad"
        type="button"
        onClick={() => setSelectedDirectoryKey(retargetingPwrGit.key)}
      />
      <Composer
        backends={[backendSummary("codex")]}
        directories={retargetingDirectories}
        directory={selectedDirectory}
        launchpad={launchpads.get(selectedDirectoryKey)!}
        onMaterializeLaunchpad={props.onMaterializeLaunchpad}
        onPickAndRegisterDirectory={() => undefined}
        onSelectDirectoryFromPicker={(directory) => {
          setSelectedDirectoryKey(directory.key);
        }}
        onUpdateLaunchpad={async (directoryKey, patch) => {
          setLaunchpads((current) => {
            const launchpad = current.get(directoryKey)!;
            const next = new Map(current);
            next.set(directoryKey, {
              ...launchpad,
              ...patch,
              updatedAt: launchpad.updatedAt + 1,
            });
            return next;
          });
        }}
        skills={[]}
      />
    </>
  );
}

function acpGeminiBackendSummary(): BackendSummary {
  return {
    ...backendSummary("acp:gemini"),
    label: "Gemini CLI",
    executionModes: [],
    acp: {
      registryId: "gemini",
      distributionKinds: ["local"],
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      runtime: {
        schemaVersion: 1,
        status: "discovered",
        modes: {
          availableModes: [
            { id: "default", label: "Default" },
            { id: "autoEdit", label: "Auto Edit" },
            { id: "yolo", label: "YOLO" },
            { id: "plan", label: "Plan" },
          ],
          currentModeId: "default",
        },
      },
    },
  };
}

function acpQwenBackendSummary(): BackendSummary {
  return {
    ...backendSummary("acp:qwen"),
    label: "Qwen Code",
    executionModes: [],
    acp: {
      registryId: "qwen",
      distributionKinds: ["local"],
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      runtime: {
        schemaVersion: 1,
        status: "discovered",
        configOptions: [
          {
            id: "mode",
            label: "Mode",
            type: "select",
            category: "mode",
            currentValue: "default",
            values: [
              { value: "default", label: "Default" },
              { value: "auto", label: "Auto" },
            ],
          },
        ],
      },
    },
  };
}

const reportedSkillAutocompleteDraftPrefix =
  "Oh shoot... I was wrong about this I think. I thought the desktop app didn't show the tool use but I was looking at a version of the desktop app that didn't start the turn. I just now looked at the instance that started the turn and it does indeed have the tool use notifications.\n\n\n\nLet's use ";

const autocompleteRegressionSkills = [
  {
    name: "adversarial-document-reviewer",
    description:
      "Conditional document-review persona, selected when the document has >5 requirements or implementation units, makes significant architectural decisions.",
    path: "/Users/huntharo/.codex/skills/adversarial-document-reviewer/SKILL.md",
    enabled: true,
  },
  {
    name: "ce:brainstorm",
    description:
      "Explore requirements and approaches through collaborative dialogue before writing a right-sized requirements document and planning implementation.",
    path: "/Users/huntharo/.codex/skills/ce-brainstorm/SKILL.md",
    enabled: true,
  },
  {
    name: "ce:compound",
    description: "Document a recently solved problem to compound your team's knowledge.",
    path: "/Users/huntharo/.codex/skills/ce-compound/SKILL.md",
    enabled: true,
  },
  {
    name: "ce:plan",
    description: "Transform feature descriptions or requirements into structured implementation plans.",
    path: "/Users/huntharo/.codex/skills/ce-plan/SKILL.md",
    enabled: true,
  },
];

function renderComposerWithRegressionSkills(
  startTurn = vi.fn(async () => ({
    backend: "codex" as const,
    threadId: "thread-1",
    turnId: "turn-1",
  })),
): { startTurn: typeof startTurn } {
  render(
    <Composer
      desktopApi={{
        onAgentEvent: () => () => undefined,
        startTurn,
      }}
      disabled={false}
      skills={autocompleteRegressionSkills}
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

  return { startTurn };
}

function createScheduledActionApi(options?: {
  sendNowStatus?: "dispatching" | "queued" | "started";
}) {
  let sequence = 0;
  const actions = new Map<string, ScheduledThreadAction>();
  const createScheduledThreadAction = vi.fn(async (
    request: CreateScheduledThreadActionRequest,
  ) => {
    sequence += 1;
    const action: ScheduledThreadAction = {
      ...request,
      id: `scheduled-${sequence}`,
      origin: request.origin ?? "desktop",
      status: "scheduled",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    actions.set(action.id, action);
    return { action };
  });
  const cancelScheduledThreadAction = vi.fn(async (
    request: ScheduledThreadActionIdRequest,
  ) => {
    const action = actions.get(request.id);
    if (!action) throw new Error("Scheduled action not found.");
    const cancelled = { ...action, status: "cancelled" as const };
    actions.set(action.id, cancelled);
    return { action: cancelled };
  });
  const sendScheduledThreadActionNow = vi.fn(async (
    request: ScheduledThreadActionIdRequest,
  ) => {
    const action = actions.get(request.id);
    if (!action) throw new Error("Scheduled action not found.");
    const status = options?.sendNowStatus ?? "started";
    const sent: ScheduledThreadAction = {
      ...action,
      status,
      ...(status === "queued"
        ? { queueEntryId: `scheduled-turn:${action.id}` }
        : {}),
    };
    actions.set(action.id, sent);
    return { action: sent };
  });
  return {
    cancelScheduledThreadAction,
    createScheduledThreadAction,
    sendScheduledThreadActionNow,
  };
}

describe("Composer", () => {
  it("persists the Auto-fix PR toggle and shows its global polling gate", async () => {
    const onSetThreadPrAutoDispatch = vi.fn(async () => undefined);
    const thread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Fix CI",
      titleSource: "explicit",
      source: "codex",
      gitOriginUrl: "git@github.com:pwrdrvr/PwrAgent.git",
      linkedDirectories: [
        {
          id: "directory-1",
          kind: "local",
          label: "PwrAgent",
          path: "/repo/PwrAgent",
        },
      ],
      inbox: { inInbox: false },
      prAutoDispatchEnabled: true,
    };
    const { rerender } = render(
      <Composer
        backgroundPrPollingEnabled
        disabled={false}
        onSetThreadPrAutoDispatch={onSetThreadPrAutoDispatch}
        skills={[]}
        thread={thread}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Auto-fix PR" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute(
      "data-tooltip",
      "Auto-fix PR — starts when a PR for this workspace is linked",
    );
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(onSetThreadPrAutoDispatch).toHaveBeenCalledWith(false);
    });

    rerender(
      <Composer
        backgroundPrPollingEnabled={false}
        disabled={false}
        onSetThreadPrAutoDispatch={onSetThreadPrAutoDispatch}
        skills={[]}
        thread={thread}
      />,
    );
    expect(screen.getByRole("button", { name: "Auto-fix PR" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Auto-fix PR" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Auto-fix PR" })).toHaveAttribute(
      "data-tooltip",
      expect.stringContaining("paused"),
    );

    rerender(
      <Composer
        backgroundPrPollingEnabled
        prAutoDispatchAllowed={false}
        disabled={false}
        onSetThreadPrAutoDispatch={onSetThreadPrAutoDispatch}
        skills={[]}
        thread={thread}
      />,
    );
    expect(screen.getByRole("button", { name: "Auto-fix PR" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Auto-fix PR" })).toHaveAttribute(
      "data-tooltip",
      expect.stringContaining("globally"),
    );
  });

  it("hides Auto-fix PR when the thread is not backed by a Git repository", () => {
    render(
      <Composer
        backgroundPrPollingEnabled
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Scratch work",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          projectKey: "/projects/scratch",
          inbox: { inInbox: false },
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Auto-fix PR" }),
    ).not.toBeInTheDocument();
  });

  it("hides Auto-fix PR for a fallback local directory without Git evidence", () => {
    render(
      <Composer
        backgroundPrPollingEnabled
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Local scratch directory",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [
            {
              id: "directory-1",
              kind: "local",
              label: "Scratch",
              path: "/projects/scratch",
            },
          ],
          inbox: { inInbox: false },
        }}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Auto-fix PR" }),
    ).not.toBeInTheDocument();
  });

  it("shows the failure-monitoring tooltip when a Git thread has a linked PR", () => {
    render(
      <Composer
        backgroundPrPollingEnabled
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Fix CI",
          titleSource: "explicit",
          source: "codex",
          gitOriginUrl: "git@github.com:pwrdrvr/PwrAgent.git",
          linkedDirectories: [
            {
              id: "directory-1",
              kind: "local",
              label: "PwrAgent",
              path: "/repo/PwrAgent",
            },
          ],
          inbox: { inInbox: false },
          prs: [
            {
              provider: "github.com",
              number: 1128,
              org: "pwrdrvr",
              repo: "PwrAgent",
              state: "passing",
              url: "https://github.com/pwrdrvr/PwrAgent/pull/1128",
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Auto-fix PR" })).toHaveAttribute(
      "data-tooltip",
      "Auto-fix PR — handle new CI failures or merge conflicts",
    );
  });

  it("shows Auto-fix PR when main resolved the primary repository for a worktree", () => {
    render(
      <Composer
        backgroundPrPollingEnabled
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Fix CI",
          titleSource: "explicit",
          source: "codex",
          primaryGitRepository: "github.com/pwrdrvr/pwragent",
          linkedDirectories: [
            {
              id: "directory-1",
              kind: "worktree",
              label: "PwrAgent",
              path: "/repo/PwrAgent",
              worktreePath: "/repo/.worktrees/fix-ci",
            },
          ],
          inbox: { inInbox: false },
          prs: [
            {
              provider: "github.com",
              number: 1128,
              org: "pwrdrvr",
              repo: "PwrAgent",
              state: "passing",
              url: "https://github.com/pwrdrvr/PwrAgent/pull/1128",
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Auto-fix PR" })).toHaveAttribute(
      "data-tooltip",
      "Auto-fix PR — handle new CI failures or merge conflicts",
    );
  });

  it("treats PRs from secondary linked repositories as informational", () => {
    render(
      <Composer
        backgroundPrPollingEnabled
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Cross-repo work",
          titleSource: "explicit",
          source: "codex",
          gitOriginUrl: "git@github.com:pwrdrvr/PwrAgent.git",
          linkedDirectories: [
            {
              id: "directory-1",
              kind: "local",
              label: "PwrAgent",
              path: "/repo/PwrAgent",
            },
            {
              id: "directory-2",
              kind: "local",
              label: "Docs",
              path: "/repo/docs.pwragent.ai",
            },
          ],
          inbox: { inInbox: false },
          prs: [
            {
              provider: "github.com",
              number: 42,
              org: "pwrdrvr",
              repo: "docs.pwragent.ai",
              state: "failing",
              url: "https://github.com/pwrdrvr/docs.pwragent.ai/pull/42",
            },
          ],
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Auto-fix PR" })).toHaveAttribute(
      "data-tooltip",
      "Auto-fix PR — starts when a PR for this workspace is linked",
    );
  });

  it("places the Agent thread menu after the reference picker and persists its choice", async () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ pickFileFromDisk: vi.fn() }}
        disabled={false}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "Repo",
          directoryPath: "/repo",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          createdAt: 1,
          updatedAt: 1,
        }}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />,
    );

    const addReference = screen.getByRole("button", { name: "Add reference" });
    const threadOptions = screen.getByRole("button", { name: "Thread options" });
    expect(
      addReference.compareDocumentPosition(threadOptions) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(threadOptions).toHaveAttribute(
      "data-tooltip",
      "Thread options",
    );

    fireEvent.click(threadOptions);
    const agentThread = screen.getByRole("menuitemcheckbox", {
      name: /Agent thread/,
    });
    expect(agentThread).toHaveAttribute("aria-checked", "false");
    expect(agentThread).not.toHaveTextContent(AGENT_THREAD_CAPABILITIES);
    expect(agentThread.parentElement).toHaveAttribute(
      "data-tooltip",
      AGENT_THREAD_CAPABILITIES,
    );

    await act(async () => {
      fireEvent.click(agentThread);
      await Promise.resolve();
    });

    expect(onUpdateLaunchpad).toHaveBeenCalledWith("directory:/repo", {
      agent: DEFAULT_DESKTOP_AGENT_THREAD,
    });
  });

  it("explains that an existing Codex thread cannot be converted into an Agent", () => {
    const setThreadAgent = vi.fn();

    render(
      <Composer
        desktopApi={{ setThreadAgent }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Existing Codex thread",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Thread options" }));
    const agentThread = screen.getByRole("menuitemcheckbox", {
      name: /Agent thread/,
    });
    expect(agentThread).toBeDisabled();
    expect(agentThread).not.toHaveTextContent(CODEX_AGENT_THREAD_CREATION_NOTE);
    expect(agentThread.parentElement).toHaveAttribute(
      "data-tooltip",
      CODEX_AGENT_THREAD_CREATION_NOTE,
    );

    fireEvent.click(agentThread);
    expect(setThreadAgent).not.toHaveBeenCalled();
  });

  it("marks an existing non-Codex thread as an Agent from the composer menu", async () => {
    const setThreadAgent = vi.fn(async () => ({
      backend: "acp:gemini" as const,
      threadId: "thread-1",
    }));
    const onRefreshNavigation = vi.fn(async () => undefined);

    render(
      <Composer
        desktopApi={{ setThreadAgent }}
        disabled={false}
        onRefreshNavigation={onRefreshNavigation}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Existing Gemini thread",
          titleSource: "explicit",
          source: "acp:gemini",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Thread options" }));
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: /Agent thread/ }),
    );

    await waitFor(() => {
      expect(setThreadAgent).toHaveBeenCalledWith({
        backend: "acp:gemini",
        threadId: "thread-1",
        agent: DEFAULT_DESKTOP_AGENT_THREAD,
      });
    });
    expect(onRefreshNavigation).toHaveBeenCalledOnce();
  });

  it("shows a cancellable on-deck countdown for a scheduled PR repair", async () => {
    const onCancelThreadPrAutoDispatch = vi.fn(async () => undefined);
    const onSendThreadPrAutoDispatchNow = vi.fn(async () => undefined);
    render(
      <Composer
        backgroundPrPollingEnabled
        disabled={false}
        onCancelThreadPrAutoDispatch={onCancelThreadPrAutoDispatch}
        onSendThreadPrAutoDispatchNow={onSendThreadPrAutoDispatchNow}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Fix CI",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
          prAutoDispatchEnabled: true,
          prAutoDispatchPending: {
            fingerprint: "fingerprint-1",
            prKey: "github.com/pwrdrvr/PwrAgent#1105",
            prNumber: 1105,
            prTitle: "Fix failed CI",
            prUrl: "https://github.com/pwrdrvr/PwrAgent/pull/1105",
            headSha: "a".repeat(40),
            eventKinds: ["ci-failure"],
            createdAt: Date.now(),
            scheduledAt: Date.now() + 30_000,
          },
        }}
      />,
    );

    expect(screen.getByLabelText("Scheduled PR auto-fix")).toHaveTextContent(
      "Auto-fix PR in",
    );
    expect(screen.getByLabelText("Scheduled PR auto-fix")).toHaveTextContent(
      "#1105 · CI failed · Fix failed CI",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    await waitFor(() => {
      expect(onSendThreadPrAutoDispatchNow).toHaveBeenCalledWith(
        "fingerprint-1",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(onCancelThreadPrAutoDispatch).toHaveBeenCalledWith(
        "fingerprint-1",
      );
    });
  });

  it("renders a newly received PR repair countdown from the current clock", () => {
    const mountedAt = new Date("2026-08-01T12:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(mountedAt);
    const thread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Fix CI",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
      prAutoDispatchEnabled: true,
    };
    const { rerender } = render(
      <Composer
        backgroundPrPollingEnabled
        disabled={false}
        skills={[]}
        thread={thread}
      />,
    );

    vi.setSystemTime(mountedAt + 90_000);
    rerender(
      <Composer
        backgroundPrPollingEnabled
        disabled={false}
        skills={[]}
        thread={{
          ...thread,
          prAutoDispatchPending: {
            fingerprint: "fingerprint-1",
            prKey: "github.com/pwrdrvr/PwrAgent#1105",
            prNumber: 1105,
            prUrl: "https://github.com/pwrdrvr/PwrAgent/pull/1105",
            headSha: "a".repeat(40),
            eventKinds: ["ci-failure"],
            createdAt: mountedAt + 90_000,
            scheduledAt: mountedAt + 120_000,
          },
        }}
      />,
    );

    expect(screen.getByLabelText("Scheduled PR auto-fix")).toHaveTextContent(
      "Auto-fix PR in 30s",
    );
  });

  it("lets launchpad errors be copied with the transcript copy control", async () => {
    const copyText = vi.fn(async () => undefined);
    const launchpadError =
      "Error invoking remote method 'agent:materialize-directory-launchpad': Cannot enable privileged approval modes in an untrusted folder.";

    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ copyText }}
        disabled={false}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/repo",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        }}
        launchpadError={launchpadError}
        skills={[]}
      />
    );

    expect(screen.getByText(launchpadError)).toHaveClass("composer__meta-text");

    fireEvent.click(screen.getByRole("button", { name: "Copy launchpad error" }));

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith(launchpadError);
    });
  });

  it("parks the launchpad's message in the recovery buffer when cancelled", async () => {
    // Cancel empties the composer without losing the message: it is recorded as
    // "abandoned" (an ArrowUp-recoverable status) and the active draft is
    // cleared. Leaving the draft in place would rehydrate it into the next
    // launchpad opened for this key and keep the row's orange marker lit.
    const deleteDraft = vi.fn();
    const recordHistory = vi.fn();
    const draftStore: ComposerDraftStore = {
      delete: deleteDraft,
      recordHistory,
      get: () => undefined,
      popDraft: () => undefined,
      pushDraft: vi.fn(),
      deletePendingSteer: vi.fn(),
      deleteQueuedTurn: vi.fn(),
      getPendingSteer: () => undefined,
      getQueuedTurn: () => undefined,
      getQueuedTurns: () => [],
      getQueuedTurnVersion: () => 0,
      subscribeQueuedTurns: () => () => undefined,
      removeQueuedTurnAt: () => undefined,
      removeQueuedTurnById: () => undefined,
      shiftQueuedTurn: () => undefined,
      setPendingSteer: vi.fn(),
      setQueuedTurn: vi.fn(),
      setQueuedTurns: vi.fn(),
      set: vi.fn(),
    };
    const onCancelLaunchpad = vi.fn();

    render(
      <Composer
        backends={[backendSummary("codex")]}
        disabled={false}
        draftStore={draftStore}
        launchpad={{
          directoryKey: "subthread:codex:thread-parent:local",
          directoryKind: "directory",
          directoryLabel: "media-service",
          directoryPath: "/repo",
          backend: "codex",
          executionMode: "default",
          prompt: "Make a PR to swap all the icons",
          workMode: "local",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        }}
        onCancelLaunchpad={onCancelLaunchpad}
        skills={[]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    // Recoverable via ArrowUp ("abandoned" is a recovery status), then cleared.
    expect(recordHistory).toHaveBeenCalledWith(
      "launchpad:subthread:codex:thread-parent:local",
      expect.objectContaining({ draft: "Make a PR to swap all the icons" }),
      "abandoned",
    );
    expect(deleteDraft).toHaveBeenCalledWith(
      "launchpad:subthread:codex:thread-parent:local",
    );
    expect(onCancelLaunchpad).toHaveBeenCalledWith(
      "subthread:codex:thread-parent:local",
    );
  });

  it("renders unavailable reason when provided", async () => {
    const unavailableReason = "Codex profile not logged in. Please check your settings.";
    render(
      <Composer
        backends={[backendSummary("codex")]}
        disabled={true}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/repo",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        }}
        unavailableReason={unavailableReason}
        skills={[]}
      />
    );

    expect(screen.getByText(unavailableReason)).toBeInTheDocument();
    expect(screen.getByText(unavailableReason)).toHaveClass("composer__meta--error");
  });

  it("opens a remote thread workspace on its owning instance", async () => {
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
          gh: {
            path: { value: "", source: "default" },
            discovery: { candidates: [] },
          },
          git: {
            discovery: { candidates: [] },
          },
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
          federation: {
            ref: {
              backend: "codex",
              target: {
                scope: "remote",
                instanceId: "remote-instance",
              },
              threadId: "thread-1",
            },
            instanceLabel: "Tart VM",
            peerStatus: "connected",
          },
          linkedDirectories: [
            {
              id: "directory-1",
              kind: "local",
              label: "PwrAgent",
              path: "/repo/PwrAgent",
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
        federationTarget: {
          scope: "remote",
          instanceId: "remote-instance",
        },
        kind: "editor",
        targetPath: "/repo/PwrAgent",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Ghostty" }));
    await waitFor(() => {
      expect(openApplication).toHaveBeenCalledWith({
        applicationId: "ghostty",
        federationTarget: {
          scope: "remote",
          instanceId: "remote-instance",
        },
        kind: "terminal",
        targetPath: "/repo/PwrAgent",
      });
    });
  });

  it("collapses a launcher to an icon-only chip when the app has a real icon", () => {
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
              iconDataUrl: "data:image/png;base64,iVBORw0KGgo=",
              canOpenWorkspace: true,
            },
          ],
          terminals: [],
          preferredEditorId: { value: "", source: "default" },
          preferredTerminalId: { value: "", source: "default" },
          gh: {
            path: { value: "", source: "default" },
            discovery: { candidates: [] },
          },
          git: {
            discovery: { candidates: [] },
          },
        }}
        backends={[backendSummary("codex")]}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Icon only",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [
            {
              id: "directory-1",
              kind: "local",
              label: "PwrAgent",
              path: "/repo/PwrAgent",
            },
          ],
          inbox: { inInbox: false },
        }}
      />,
    );

    // Accessible name comes from aria-label; the visible text label is dropped
    // in favor of the real logo.
    const button = screen.getByRole("button", { name: "VS Code" });
    expect(button).toHaveClass("composer__application-button--icon-only");
    expect(button.querySelector("img")).not.toBeNull();
    expect(button).not.toHaveTextContent("VS Code");
  });

  it("flags the access-mode chip as danger when full access is selected", () => {
    render(
      <Composer
        backends={[
          {
            ...backendSummary("codex"),
            executionModes: [
              { mode: "default", label: "Default Access", available: true, isDefault: true },
              { mode: "full-access", label: "Full Access", available: true },
            ],
          },
        ]}
        desktopApi={{ onAgentEvent: () => () => undefined }}
        disabled={false}
        onSetExecutionMode={async () => undefined}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Full access",
          titleSource: "explicit",
          source: "codex",
          executionMode: "full-access",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />,
    );

    expect(
      screen.getByLabelText("Access mode").closest(".composer-dropdown"),
    ).toHaveClass("composer-dropdown--danger");
  });

  it("does not show workspace application buttons on a launchpad before the thread exists", () => {
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
          gh: {
            path: { value: "", source: "default" },
            discovery: { candidates: [] },
          },
          git: {
            discovery: { candidates: [] },
          },
        }}
        backends={[backendSummary("codex")]}
        disabled={false}
        launchpad={{
          directoryKey: "directory:/repo/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/repo/PwrAgent",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        }}
        skills={[]}
      />,
    );

    expect(screen.queryByRole("button", { name: "VS Code" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ghostty" })).not.toBeInTheDocument();
  });

  it("does not offer the controller's disk picker in a remote launchpad", () => {
    (window as unknown as {
      __pwragentFederationTarget?: unknown;
    }).__pwragentFederationTarget = {
      scope: "remote",
      instanceId: "remote-instance",
    };
    const onPickAndRegisterDirectory = vi.fn();

    render(
      <Composer
        backends={[backendSummary("codex")]}
        directories={[
          {
            key: "directory:/remote/repo",
            kind: "directory",
            label: "Remote repo",
            path: "/remote/repo",
            threadKeys: [],
            needsAttentionCount: 0,
          },
        ]}
        disabled={false}
        launchpad={{
          directoryKey: "workspace:new-thread",
          directoryKind: "workspace",
          directoryLabel: "Workspaces",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          createdAt: 1,
          updatedAt: 1,
        }}
        onPickAndRegisterDirectory={onPickAndRegisterDirectory}
        onSelectDirectoryFromPicker={() => undefined}
        skills={[]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Choose a project" }));

    expect(screen.getByRole("option", { name: /remote repo/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /add directory/i }),
    ).not.toBeInTheDocument();
    expect(onPickAndRegisterDirectory).not.toHaveBeenCalled();
  });

  it("shows thread environment commands from refreshed environment options", async () => {
    const runCodexEnvironmentAction = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      codexEnvironmentRuntime: {
        environmentId: "environment",
        environmentName: "PwrAgnt",
        executionTarget: "local" as const,
      },
    }));
    const setCodexThreadEnvironment = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
    }));
    const thread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Environment commands",
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      linkedDirectories: [
        {
          id: "fixture-repo",
          label: "FixtureRepo",
          path: "/repo/FixtureRepo",
          worktreePath: "/repo/.worktrees/thread-1/FixtureRepo",
          kind: "worktree",
        },
      ],
      inbox: { inInbox: false },
      codexEnvironmentRuntime: {
        environmentId: "environment",
        environmentName: "PwrAgnt",
        executionTarget: "local",
        actions: [],
      },
      codexEnvironmentOptions: [
        {
          id: "environment",
          name: "PwrAgnt",
          sourcePath: "/repo/.codex/environments/environment.toml",
          actions: [
            {
              id: "dev-messaging",
              name: "Dev - Messaging",
              command: "pnpm dev:messaging",
            },
          ],
        },
      ],
    };

    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ runCodexEnvironmentAction, setCodexThreadEnvironment }}
        disabled={false}
        skills={[]}
        thread={thread}
      />,
    );

    expect(screen.getByLabelText("Environment")).toHaveTextContent("PwrAgnt");
    expect(screen.getByLabelText("Environment command")).toHaveTextContent(
      "Dev - Messaging",
    );
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => {
      expect(runCodexEnvironmentAction).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        actionId: "dev-messaging",
        cwd: "/repo/.worktrees/thread-1/FixtureRepo",
      });
    });

    chooseDropdownOption("Environment", "No environment");
    await waitFor(() => {
      expect(setCodexThreadEnvironment).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        environmentId: undefined,
        actionId: undefined,
      });
    });
  });

  it("shows a disabled spinner on the environment Run button after starting", async () => {
    vi.useFakeTimers();
    const runCodexEnvironmentAction = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      codexEnvironmentRuntime: {
        environmentId: "environment",
        environmentName: "PwrAgnt",
        executionTarget: "local" as const,
      },
    }));
    const thread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Environment commands",
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      linkedDirectories: [],
      inbox: { inInbox: false },
      codexEnvironmentRuntime: {
        environmentId: "environment",
        environmentName: "PwrAgnt",
        executionTarget: "local",
        actions: [
          {
            id: "dev-messaging",
            name: "Dev - Messaging",
            command: "pnpm dev:messaging",
          },
        ],
      },
    };

    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ runCodexEnvironmentAction }}
        disabled={false}
        skills={[]}
        thread={thread}
      />,
    );

    const runButton = screen.getByRole("button", { name: "Run" });
    expect(runButton).not.toBeDisabled();

    await act(async () => {
      fireEvent.click(runButton);
      await Promise.resolve();
    });

    expect(runCodexEnvironmentAction).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      actionId: "dev-messaging",
    });
    expect(runButton).toBeDisabled();
    expect(runButton).not.toHaveTextContent("Run");
    expect(
      runButton.querySelector(".composer__action-button-spinner"),
    ).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(4_999);
    });
    expect(runButton).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(runButton).not.toBeDisabled();
    expect(
      runButton.querySelector(".composer__action-button-spinner"),
    ).not.toBeInTheDocument();
  });

  it("does not leak environment Run busy state across thread changes", async () => {
    vi.useFakeTimers();
    const startDeferred = createDeferred<{
      backend: "codex";
      threadId: string;
      codexEnvironmentRuntime: {
        environmentId: string;
        environmentName: string;
        executionTarget: "local";
      };
    }>();
    const runCodexEnvironmentAction = vi.fn(() => startDeferred.promise);
    const buildThread = (id: string, actionId: string): NavigationThreadSummary => ({
      id,
      title: id,
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      linkedDirectories: [],
      inbox: { inInbox: false },
      codexEnvironmentRuntime: {
        environmentId: "environment",
        environmentName: "PwrAgnt",
        executionTarget: "local",
        actions: [
          {
            id: actionId,
            name: `Action ${actionId}`,
            command: "pnpm test",
          },
        ],
      },
    });

    const { rerender } = render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ runCodexEnvironmentAction }}
        disabled={false}
        skills={[]}
        thread={buildThread("thread-a", "test-a")}
      />,
    );

    const firstRunButton = screen.getByRole("button", { name: "Run" });
    await act(async () => {
      fireEvent.click(firstRunButton);
      await Promise.resolve();
    });
    expect(firstRunButton).toBeDisabled();

    rerender(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ runCodexEnvironmentAction }}
        disabled={false}
        skills={[]}
        thread={buildThread("thread-b", "test-b")}
      />,
    );

    const secondRunButton = screen.getByRole("button", { name: "Run" });
    expect(secondRunButton).not.toBeDisabled();
    expect(
      secondRunButton.querySelector(".composer__action-button-spinner"),
    ).toBeNull();

    await act(async () => {
      startDeferred.resolve({
        backend: "codex",
        threadId: "thread-a",
        codexEnvironmentRuntime: {
          environmentId: "environment",
          environmentName: "PwrAgnt",
          executionTarget: "local",
        },
      });
      await Promise.resolve();
    });

    expect(secondRunButton).not.toBeDisabled();
  });

  it("restores thread environment command selections from the per-env sticky map", () => {
    const buildThread = (
      id: string,
      actionId: string,
    ): NavigationThreadSummary => ({
      id,
      title: id,
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      linkedDirectories: [],
      inbox: { inInbox: false },
      codexEnvironmentRuntime: {
        environmentId: "environment",
        environmentName: "PwrAgnt",
        executionTarget: "local",
        selectedActionIdByEnvironmentId: {
          environment: actionId,
        },
      },
      codexEnvironmentOptions: [
        {
          id: "environment",
          name: "PwrAgnt",
          sourcePath: "/repo/.codex/environments/environment.toml",
          actions: [
            {
              id: "dev",
              name: "Dev",
              command: "pnpm dev",
            },
            {
              id: "test",
              name: "Test",
              command: "pnpm test",
            },
          ],
        },
      ],
    });

    const { rerender } = render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ setCodexThreadEnvironment: vi.fn() }}
        disabled={false}
        skills={[]}
        thread={buildThread("thread-a", "test")}
      />,
    );

    expect(screen.getByLabelText("Environment command")).toHaveTextContent("Test");

    rerender(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ setCodexThreadEnvironment: vi.fn() }}
        disabled={false}
        skills={[]}
        thread={buildThread("thread-b", "dev")}
      />,
    );

    expect(screen.getByLabelText("Environment command")).toHaveTextContent("Dev");

    rerender(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ setCodexThreadEnvironment: vi.fn() }}
        disabled={false}
        skills={[]}
        thread={buildThread("thread-a", "test")}
      />,
    );

    expect(screen.getByLabelText("Environment command")).toHaveTextContent("Test");
  });

  it("persists thread environment command changes without running the action", async () => {
    const setCodexThreadEnvironment = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      codexEnvironmentRuntime: {
        environmentId: "environment",
        environmentName: "PwrAgnt",
        executionTarget: "local" as const,
        selectedActionIdByEnvironmentId: {
          environment: "test",
        },
      },
    }));
    const runCodexEnvironmentAction = vi.fn();

    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ runCodexEnvironmentAction, setCodexThreadEnvironment }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Environment commands",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            selectedActionIdByEnvironmentId: {
              environment: "dev",
            },
          },
          codexEnvironmentOptions: [
            {
              id: "environment",
              name: "PwrAgnt",
              sourcePath: "/repo/.codex/environments/environment.toml",
              actions: [
                {
                  id: "dev",
                  name: "Dev",
                  command: "pnpm dev",
                },
                {
                  id: "test",
                  name: "Test",
                  command: "pnpm test",
                },
              ],
            },
          ],
        }}
      />,
    );

    chooseDropdownOption("Environment command", "Test");

    await waitFor(() => {
      expect(setCodexThreadEnvironment).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        environmentId: "environment",
        actionId: "test",
      });
    });
    expect(runCodexEnvironmentAction).not.toHaveBeenCalled();
  });

  it("shows an explicit empty state when a selected environment has no commands", () => {
    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ runCodexEnvironmentAction: vi.fn() }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Environment commands",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
          codexEnvironmentRuntime: {
            environmentId: "environment",
            environmentName: "PwrAgnt",
            executionTarget: "local",
            actions: [],
          },
          codexEnvironmentOptions: [
            {
              id: "environment",
              name: "PwrAgnt",
              sourcePath: "/repo/.codex/environments/environment.toml",
              actions: [],
            },
          ],
        }}
      />,
    );

    expect(screen.getByLabelText("Environment command")).toHaveTextContent(
      "No commands",
    );
    expect(screen.getByLabelText("Environment command")).toBeDisabled();
    expect(screen.getByLabelText("Environment")).toHaveTextContent("PwrAgnt");
  });

  it("hides thread environment commands when no environment is selected", () => {
    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ setCodexThreadEnvironment: vi.fn() }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Environment commands",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
          codexEnvironmentOptions: [
            {
              id: "environment",
              name: "PwrAgnt",
              sourcePath: "/repo/.codex/environments/environment.toml",
              actions: [
                {
                  id: "dev-messaging",
                  name: "Dev - Messaging",
                  command: "pnpm dev:messaging",
                },
              ],
            },
          ],
        }}
      />,
    );

    expect(screen.getByLabelText("Environment")).toHaveTextContent(
      "No environment",
    );
    expect(screen.queryByLabelText("Environment command")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run" })).not.toBeInTheDocument();
  });

  it("does not show environment commands on a launchpad", () => {
    render(
      <Composer
        backends={[backendSummary("codex")]}
        disabled={false}
        directory={{
          key: "directory:/repo/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/repo/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={{
          directoryKey: "directory:/repo/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/repo/PwrAgent",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          codexEnvironmentId: "environment",
          codexEnvironmentOptions: [
            {
              id: "environment",
              name: "PwrAgnt",
              sourcePath: "/repo/.codex/environments/environment.toml",
              setupScript: "pnpm install",
              actions: [
                {
                  id: "dev-messaging",
                  name: "Dev - Messaging",
                  command: "pnpm dev:messaging",
                },
              ],
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        }}
        skills={[]}
      />,
    );

    expect(screen.getByLabelText("Environment")).toHaveTextContent("PwrAgnt");
    expect(screen.queryByText("Run setup")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Environment command")).not.toBeInTheDocument();
    expect(screen.queryByText("No command")).not.toBeInTheDocument();
  });

  it.each([
    ["acp:gemini", acpGeminiBackendSummary()],
    ["acp:kimi", backendSummary("acp:kimi")],
  ] as const)("shows the launchpad environment picker for %s", (_backendId, backend) => {
    const updateLaunchpad = vi.fn(async () => undefined);
    render(
      <Composer
        backends={[backend]}
        disabled={false}
        launchpad={{
          directoryKey: "directory:/repo/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/repo/PwrAgent",
          backend: backend.kind,
          executionMode: "default",
          prompt: "",
          workMode: "local",
          codexEnvironmentOptions: [
            {
              id: "environment",
              name: "PwrAgnt",
              sourcePath: "/repo/.codex/environments/environment.toml",
              setupScript: "pnpm install",
              actions: [],
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        }}
        onUpdateLaunchpad={updateLaunchpad}
        skills={[]}
      />,
    );

    expect(screen.getByLabelText("Environment")).toHaveTextContent(
      "No environment",
    );

    chooseDropdownOption("Environment", "PwrAgnt");

    expect(updateLaunchpad).toHaveBeenCalledWith(
      "directory:/repo/PwrAgent",
      expect.objectContaining({
        codexEnvironmentId: "environment",
        codexEnvironmentExecutionTarget: "local",
      }),
      expect.any(Object),
    );
  });

  it("does not show launchpad environment commands", () => {
    const updateLaunchpad = vi.fn(async () => undefined);
    render(
      <Composer
        backends={[backendSummary("codex")]}
        disabled={false}
        launchpad={{
          directoryKey: "directory:/repo/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/repo/PwrAgent",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          codexEnvironmentId: "lunch",
          codexEnvironmentOptions: [
            {
              id: "lunch",
              name: "Lunch",
              sourcePath: "/repo/.codex/environments/lunch.toml",
              actions: [
                {
                  id: "sandwich",
                  name: "Sandwich",
                  command: "make sandwich",
                },
                {
                  id: "dessert",
                  name: "Dessert",
                  command: "make dessert",
                },
              ],
            },
            {
              id: "dinner",
              name: "Dinner",
              sourcePath: "/repo/.codex/environments/dinner.toml",
              actions: [
                {
                  id: "pasta",
                  name: "Pasta",
                  command: "make pasta",
                },
                {
                  id: "wine",
                  name: "Wine",
                  command: "open wine",
                },
              ],
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        }}
        onUpdateLaunchpad={updateLaunchpad}
        skills={[]}
      />,
    );

    expect(screen.getByLabelText("Environment")).toHaveTextContent("Lunch");
    expect(screen.queryByLabelText("Environment command")).not.toBeInTheDocument();

    chooseDropdownOption("Environment", "Dinner");

    expect(updateLaunchpad).toHaveBeenCalledWith(
      "directory:/repo/PwrAgent",
      expect.objectContaining({
        codexEnvironmentId: "dinner",
        codexEnvironmentActionId: undefined,
      }),
      expect.any(Object),
    );
  });

  it("shows an orange moon for reported context window usage", () => {
    render(
      <Composer
        backends={[backendSummary("codex")]}
        contextWindow={{
          cachedInputTokens: 32_000,
          cumulativeCachedInputTokens: 48_000,
          cumulativeInputTokens: 72_000,
          cumulativeOutputTokens: 8_000,
          cumulativeReasoningOutputTokens: 4_000,
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

    const moon = screen.getByRole("img", {
      name: "Context window 50% full, 64k/128k tokens, full moon",
    });
    expect(moon).toBeInTheDocument();
    expect(moon).not.toHaveAttribute("title");
    expect(moon).not.toHaveAttribute("data-tooltip");
    expect(screen.getByText("50%")).toBeInTheDocument();

    // Hovering the moon opens the structured usage card.
    fireEvent.mouseEnter(moon);
    const card = screen.getByRole("tooltip");
    expect(within(card).getByText("Context window")).toBeInTheDocument();
    expect(within(card).getByText("full moon")).toBeInTheDocument();
    expect(within(card).getByText("50% full")).toBeInTheDocument();
    expect(within(card).getByText("64k left")).toBeInTheDocument();
    expect(within(card).getByText("64k of 128k tokens")).toBeInTheDocument();

    expect(within(card).getByText("Current request")).toBeInTheDocument();
    expect(within(card).getByText("Input")).toBeInTheDocument();
    expect(within(card).getByText("63k")).toBeInTheDocument();
    expect(within(card).getByText("32k cached (50.8%)")).toBeInTheDocument();
    expect(within(card).getAllByText("Output")).toHaveLength(2);
    expect(within(card).getByText("1k")).toBeInTheDocument();

    expect(within(card).getByText("Session total")).toBeInTheDocument();
    expect(within(card).getByText("80k")).toBeInTheDocument();
    expect(within(card).getByText("48k cached (66.7%)")).toBeInTheDocument();
    expect(within(card).getByText("8k")).toBeInTheDocument();
    expect(within(card).getByText("Reasoning")).toBeInTheDocument();
    expect(within(card).getByText("4k")).toBeInTheDocument();

    fireEvent.mouseLeave(moon);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("live-updates the open context usage card as token usage changes", () => {
    const thread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Context usage",
      titleSource: "explicit",
      source: "codex",
      executionMode: "default",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const composerFor = (
      contextWindow:
        | Parameters<typeof Composer>[0]["contextWindow"]
        | undefined
    ) => (
      <Composer
        backends={[backendSummary("codex")]}
        contextWindow={contextWindow}
        disabled={false}
        skills={[]}
        thread={thread}
      />
    );

    const { rerender } = render(
      composerFor({
        modelContextWindow: 128_000,
        phase: 4,
        remainingPercent: 50,
        remainingTokens: 64_000,
        totalTokens: 64_000,
        usedPercent: 50,
      })
    );

    fireEvent.mouseEnter(screen.getByRole("img", { name: /Context window/ }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("50% full");

    // A fresh token-usage notification while the card is open updates it
    // in place — no re-hover required.
    rerender(
      composerFor({
        modelContextWindow: 128_000,
        phase: 6,
        remainingPercent: 25,
        remainingTokens: 32_000,
        totalTokens: 96_000,
        usedPercent: 75,
      })
    );

    const card = screen.getByRole("tooltip");
    expect(card).toHaveTextContent("75% full");
    expect(card).toHaveTextContent("32k left");
    expect(card).toHaveTextContent("96k of 128k tokens");
    expect(card).not.toHaveTextContent("50% full");

    // Losing the context state entirely (thread switch) drops the card.
    rerender(composerFor(undefined));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
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

  it("adopts the refreshed ACP default when the provider is selected", async () => {
    const staleKimi = {
      ...backendSummary("acp:kimi", {
        models: [
          {
            id: "kimi-code/kimi-for-coding",
            label: "Kimi-k2.6",
            current: true,
          },
        ],
      }),
      label: "Kimi",
    };
    const refreshedKimi = {
      ...staleKimi,
      launchpadOptions: {
        models: [
          {
            id: "kimi-code/kimi-for-coding",
            label: "K2.7 Coding",
          },
          {
            id: "kimi-code/k3",
            label: "K3",
            current: true,
          },
        ],
      },
    };
    const onProviderSelected = vi.fn(async () => refreshedKimi);
    const onUpdateLaunchpad = vi.fn(async () => undefined);
    const launchpad: NavigationLaunchpadDraft = {
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
    };
    const composer = (nextLaunchpad: NavigationLaunchpadDraft) => (
      <Composer
        backends={[backendSummary("codex"), staleKimi]}
        launchpad={nextLaunchpad}
        onProviderSelected={onProviderSelected}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );
    const { rerender } = render(composer(launchpad));

    chooseDropdownOption("Provider", "Kimi");
    rerender(
      composer({
        ...launchpad,
        backend: "acp:kimi",
        model: "kimi-code/kimi-for-coding",
      }),
    );

    await waitFor(() => {
      expect(onProviderSelected).toHaveBeenCalledWith("acp:kimi");
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        expect.objectContaining({
          model: "kimi-code/k3",
          reasoningEffort: undefined,
        }),
        { stickySettingsChanged: true },
      );
    });
  });

  it("prefers a valid profile baseline over the refreshed ACP recommendation", async () => {
    const staleKimi = {
      ...backendSummary("acp:kimi", {
        models: [
          {
            id: "kimi-code/kimi-for-coding",
            label: "Kimi-k2.6",
            current: true,
          },
        ],
      }),
      label: "Kimi",
    };
    const refreshedKimi = {
      ...staleKimi,
      launchpadOptions: {
        models: [
          {
            id: "kimi-code/kimi-for-coding",
            label: "K2.7 Coding",
            current: true,
          },
          {
            id: "kimi-code/k3",
            label: "K3",
            defaultReasoningEffort: "high",
            reasoningEfforts: ["low", "high", "max"],
            supportsReasoning: true,
          },
        ],
      },
    };
    const onProviderSelected = vi.fn(async () => refreshedKimi);
    const onUpdateLaunchpad = vi.fn(async () => undefined);
    const launchpad: NavigationLaunchpadDraft = {
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
    };
    const composer = (nextLaunchpad: NavigationLaunchpadDraft) => (
      <Composer
        backends={[backendSummary("codex"), staleKimi]}
        launchpad={nextLaunchpad}
        onProviderSelected={onProviderSelected}
        onUpdateLaunchpad={onUpdateLaunchpad}
        providerModelDefaults={{
          "acp:kimi": {
            model: "kimi-code/k3",
            reasoningEffortsByModel: {
              "kimi-code/k3": "max",
            },
          },
        }}
        skills={[]}
      />
    );
    const { rerender } = render(composer(launchpad));

    chooseDropdownOption("Provider", "Kimi");
    rerender(
      composer({
        ...launchpad,
        backend: "acp:kimi",
        model: "kimi-code/kimi-for-coding",
      }),
    );

    await waitFor(() => {
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        expect.objectContaining({
          model: "kimi-code/k3",
          reasoningEffort: "max",
        }),
        { stickySettingsChanged: true },
      );
    });
  });

  it("preserves a model and reasoning choice made while ACP discovery runs", async () => {
    const staleKimi = {
      ...backendSummary("acp:kimi", {
        models: [
          {
            id: "kimi-code/kimi-for-coding",
            label: "K2.7 Coding",
            current: true,
          },
          {
            id: "kimi-code/k3",
            label: "K3",
            defaultReasoningEffort: "high",
            reasoningEfforts: ["low", "high", "max"],
            supportsReasoning: true,
          },
        ],
      }),
      label: "Kimi",
    };
    const refreshedKimi = {
      ...staleKimi,
      launchpadOptions: {
        models: [
          {
            id: "kimi-code/kimi-for-coding",
            label: "K2.7 Coding",
            current: true,
          },
          {
            id: "kimi-code/k3",
            label: "K3",
            defaultReasoningEffort: "high",
            reasoningEfforts: ["low", "high", "max"],
            supportsReasoning: true,
          },
        ],
      },
    };
    const discovery = createDeferred<BackendSummary | undefined>();
    const onProviderSelected = vi.fn(() => discovery.promise);
    const onUpdateLaunchpad = vi.fn(async () => undefined);
    const launchpad: NavigationLaunchpadDraft = {
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
    };
    const composer = (nextLaunchpad: NavigationLaunchpadDraft) => (
      <Composer
        backends={[backendSummary("codex"), staleKimi]}
        launchpad={nextLaunchpad}
        onProviderSelected={onProviderSelected}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );
    const { rerender } = render(composer(launchpad));

    chooseDropdownOption("Provider", "Kimi");
    rerender(
      composer({
        ...launchpad,
        backend: "acp:kimi",
        model: "kimi-code/kimi-for-coding",
      }),
    );
    await waitFor(() => {
      expect(onProviderSelected).toHaveBeenCalledWith("acp:kimi");
    });
    onUpdateLaunchpad.mockClear();

    rerender(
      composer({
        ...launchpad,
        backend: "acp:kimi",
        model: "kimi-code/k3",
        reasoningEffort: "max",
      }),
    );
    await act(async () => {
      discovery.resolve(refreshedKimi);
      await discovery.promise;
    });

    expect(onUpdateLaunchpad).not.toHaveBeenCalled();
  });

  it("refreshes a persisted ACP launchpad and replaces a removed model", async () => {
    const refreshedKimi = {
      ...backendSummary("acp:kimi", {
        models: [
          {
            id: "kimi-code/k3",
            label: "K3",
            current: true,
          },
        ],
      }),
      label: "Kimi",
    };
    const onProviderSelected = vi.fn(async () => refreshedKimi);
    const onUpdateLaunchpad = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[
          {
            ...backendSummary("acp:kimi", {
              models: [
                {
                  id: "kimi-code/kimi-for-coding",
                  label: "Kimi-k2.6",
                  current: true,
                },
              ],
            }),
            label: "Kimi",
          },
        ]}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "Repo",
          directoryPath: "/repo",
          backend: "acp:kimi",
          executionMode: "default",
          model: "kimi-code/kimi-for-coding",
          prompt: "",
          workMode: "local",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        }}
        onProviderSelected={onProviderSelected}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />,
    );

    await waitFor(() => {
      expect(onProviderSelected).toHaveBeenCalledTimes(1);
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        expect.objectContaining({
          model: "kimi-code/k3",
          reasoningEffort: undefined,
        }),
        { stickySettingsChanged: true },
      );
    });
  });

  it("remembers Kimi thinking effort separately for each model", async () => {
    const kimiBackend = {
      ...backendSummary("acp:kimi", {
        models: [
          {
            id: "kimi-code/k3",
            label: "K3",
            current: true,
            defaultReasoningEffort: "high",
            reasoningEfforts: ["low", "high", "max"],
            supportsReasoning: true,
          },
          {
            id: "kimi-code/k3-256k",
            label: "K3-256k",
            defaultReasoningEffort: "high",
            reasoningEfforts: ["low", "high", "max"],
            supportsReasoning: true,
          },
        ],
      }),
      label: "Kimi",
    };
    const initialLaunchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/repo",
      directoryKind: "directory",
      directoryLabel: "Repo",
      directoryPath: "/repo",
      backend: "acp:kimi",
      executionMode: "default",
      model: "kimi-code/k3",
      reasoningEffort: "max",
      providerSettings: {
        "acp:kimi": {
          model: "kimi-code/k3",
          reasoningEffort: "max",
          reasoningEffortsByModel: {
            "kimi-code/k3": "max",
            "kimi-code/k3-256k": "low",
          },
        },
      },
      prompt: "",
      workMode: "local",
      branchName: "main",
      createdAt: 1,
      updatedAt: 1,
    };

    function KimiThinkingHarness(): React.JSX.Element {
      const [launchpad, setLaunchpad] = useState(initialLaunchpad);
      return (
        <Composer
          backends={[kimiBackend]}
          launchpad={launchpad}
          onUpdateLaunchpad={async (_directoryKey, patch) => {
            setLaunchpad((current) =>
              applyNavigationLaunchpadProviderSettingsPatch<
                NavigationLaunchpadDraft
              >(current, patch),
            );
          }}
          skills={[]}
        />
      );
    }

    render(<KimiThinkingHarness />);

    expect(screen.getByLabelText("Reasoning")).toHaveValue("max");
    chooseDropdownOption("Model", "K3-256k");
    await waitFor(() => {
      expect(screen.getByLabelText("Reasoning")).toHaveValue("low");
    });

    chooseDropdownOption("Reasoning", "high");
    chooseDropdownOption("Model", "K3");
    await waitFor(() => {
      expect(screen.getByLabelText("Reasoning")).toHaveValue("max");
    });

    chooseDropdownOption("Model", "K3-256k");
    await waitFor(() => {
      expect(screen.getByLabelText("Reasoning")).toHaveValue("high");
    });
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

  it("shows Grok 4.5 ACP reasoning effort in the launchpad", () => {
    render(
      <Composer
        backends={[
          backendSummary("acp:grok", {
            models: [
              {
                id: "grok-4.5",
                label: "Grok 4.5",
                current: true,
                defaultReasoningEffort: "high",
                reasoningEfforts: ["low", "medium", "high"],
                supportsReasoning: true,
              },
            ],
          }),
        ]}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "Repo",
          directoryPath: "/repo",
          backend: "acp:grok",
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

    expect(screen.getByLabelText("Model")).toHaveValue("grok-4.5");
    expect(screen.getByLabelText("Reasoning")).toHaveValue("high");
  });

  it("restores provider-specific launchpad settings across repeated OpenAI and Grok flips", async () => {
    const codexBackend = {
      ...backendSummary("codex", {
        models: [
          {
            id: "gpt-5.6-sol",
            label: "GPT-5.6 Sol",
            current: true,
            reasoningEfforts: ["medium", "high", "ultra"],
            supportsFast: true,
            supportsReasoning: true,
          },
          {
            id: "gpt-5.6-luna",
            label: "GPT-5.6 Luna",
            reasoningEfforts: ["medium", "high"],
            supportsFast: true,
            supportsReasoning: true,
          },
        ],
        reasoningEfforts: ["medium", "high", "ultra"],
        supportsFastMode: true,
      }),
      label: "OpenAI",
      executionModes: [
        {
          mode: "default" as const,
          label: "Default Access",
          available: true,
          isDefault: true,
        },
        {
          mode: "full-access" as const,
          label: "Full Access",
          available: true,
        },
      ],
    } satisfies BackendSummary;
    const grokBackend = {
      ...backendSummary("acp:grok", {
        models: [
          {
            id: "grok-4.5",
            label: "Grok 4.5",
            current: true,
            defaultReasoningEffort: "high",
            reasoningEfforts: ["low", "medium", "high"],
            supportsReasoning: true,
          },
          {
            id: "grok-4.5-pro",
            label: "Grok 4.5 Pro",
            defaultReasoningEffort: "medium",
            reasoningEfforts: ["low", "medium", "high"],
            supportsReasoning: true,
          },
        ],
        reasoningEfforts: ["low", "medium", "high"],
        serviceTiers: ["standard", "priority"],
      }),
      label: "Grok CLI",
      executionModes: [
        {
          mode: "default" as const,
          label: "Default Access",
          available: true,
          isDefault: true,
        },
        {
          mode: "full-access" as const,
          label: "Full Access",
          available: true,
        },
      ],
      acp: {
        registryId: "grok",
        distributionKinds: ["local"],
        installStatus: "installed",
        authStatus: "not-required",
        verificationStatus: "not-applicable",
        runtime: {
          schemaVersion: 1,
          status: "discovered",
          modes: {
            availableModes: [
              { id: "default", label: "Default" },
              { id: "yolo", label: "YOLO" },
            ],
            currentModeId: "default",
          },
        },
      },
    } satisfies BackendSummary;
    const initialLaunchpad: NavigationLaunchpadDraft = {
      directoryKey: "directory:/repo",
      directoryKind: "directory",
      directoryLabel: "Repo",
      directoryPath: "/repo",
      backend: "codex",
      executionMode: "full-access",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      fastMode: true,
      codexEnvironmentId: "codex-environment",
      codexEnvironmentExecutionTarget: "local",
      codexEnvironmentActionId: "codex-action",
      codexEnvironmentOptions: [
        {
          id: "codex-environment",
          name: "Codex Environment",
          sourcePath: "/repo/.codex/environments/codex-environment.toml",
          actions: [],
        },
        {
          id: "grok-environment",
          name: "Grok Environment",
          sourcePath: "/repo/.codex/environments/grok-environment.toml",
          actions: [],
        },
      ],
      providerSettings: {
        codex: {
          executionMode: "full-access",
          model: "gpt-5.6-luna",
          reasoningEffort: "high",
          reasoningEffortsByModel: {
            "gpt-5.6-luna": "high",
            "gpt-5.6-sol": "ultra",
          },
          fastMode: true,
          codexEnvironmentId: "codex-environment",
          codexEnvironmentExecutionTarget: "local",
          codexEnvironmentActionId: "codex-action",
        },
        "acp:grok": {
          executionMode: "full-access",
          model: "grok-4.5-pro",
          reasoningEffort: "low",
          reasoningEffortsByModel: {
            "grok-4.5-pro": "low",
          },
          serviceTier: "priority",
          acpRuntime: {
            currentModeId: "yolo",
          },
          codexEnvironmentId: "grok-environment",
          codexEnvironmentExecutionTarget: "local",
          codexEnvironmentActionId: "grok-action",
        },
      },
      prompt: "",
      workMode: "worktree",
      branchName: "feature/provider-memory",
      createdAt: 1,
      updatedAt: 1,
    };
    const providerPatches: Array<Partial<NavigationLaunchpadDraft>> = [];
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1,
      entries: [],
    }));
    const listBackends = vi.fn(async () => ({
      fetchedAt: 1,
      backends: [codexBackend, grokBackend],
    }));

    function ProviderSwitchHarness(): React.JSX.Element {
      const [launchpad, setLaunchpad] = useState(initialLaunchpad);
      return (
        <Composer
          backends={[codexBackend, grokBackend]}
          desktopApi={{
            listAcpAgents,
            listBackends,
          }}
          directory={{
            key: "directory:/repo",
            kind: "directory",
            label: "Repo",
            path: "/repo",
            threadKeys: [],
            needsAttentionCount: 0,
            gitStatus: {
              currentBranch: "feature/provider-memory",
              branches: ["feature/provider-memory", "main"],
              syncState: "in-sync",
            },
          }}
          fullAccessRiskWarningDismissed
          launchpad={launchpad}
          onUpdateLaunchpad={async (_directoryKey, patch) => {
            providerPatches.push(patch);
            setLaunchpad((current) =>
              applyNavigationLaunchpadProviderSettingsPatch<NavigationLaunchpadDraft>(
                current,
                patch,
              ),
            );
          }}
          skills={[]}
        />
      );
    }

    render(<ProviderSwitchHarness />);

    expect(screen.getByLabelText("Access mode")).toHaveValue("full-access");
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-5.6-luna");
    expect(screen.getByLabelText("Reasoning")).toHaveValue("high");
    expect(screen.getByLabelText("Fast mode")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Environment")).toHaveTextContent("Codex Environment");

    chooseDropdownOption("Model", "GPT-5.6 Sol");
    await waitFor(() => {
      expect(screen.getByLabelText("Model")).toHaveValue("gpt-5.6-sol");
      expect(screen.getByLabelText("Reasoning")).toHaveValue("ultra");
    });

    chooseDropdownOption("Provider", "Grok");
    await waitFor(() => {
      expect(screen.getByLabelText("Provider")).toHaveValue("acp:grok");
    });
    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalledWith({ refresh: true });
      expect(listBackends).toHaveBeenCalledWith({
        includeUnavailable: true,
        refreshModels: "acp:grok",
      });
    });
    expect(providerPatches.at(-1)).toEqual({
      backend: "acp:grok",
      fileAttachments: undefined,
      imageAttachments: undefined,
      prompt: "",
    });
    expect(screen.getByLabelText("Access mode")).toHaveValue("full-access");
    expect(screen.getByLabelText("Agent mode")).toHaveValue("yolo");
    expect(screen.getByLabelText("Model")).toHaveValue("grok-4.5-pro");
    expect(screen.getByLabelText("Reasoning")).toHaveValue("low");
    expect(screen.getByLabelText("Service tier")).toHaveValue("priority");
    expect(screen.getByLabelText("Environment")).toHaveTextContent("Grok Environment");
    expect(screen.getByLabelText("Workspace mode")).toHaveValue("worktree");
    expect(screen.getByLabelText("Base branch")).toHaveValue(
      "feature/provider-memory",
    );

    chooseDropdownOption("Reasoning", "medium");
    chooseDropdownOption("Service tier", "standard");
    await waitFor(() => {
      expect(screen.getByLabelText("Reasoning")).toHaveValue("medium");
      expect(screen.getByLabelText("Service tier")).toHaveValue("standard");
    });

    chooseDropdownOption("Provider", "OpenAI");
    await waitFor(() => {
      expect(screen.getByLabelText("Provider")).toHaveValue("codex");
    });
    expect(screen.getByLabelText("Access mode")).toHaveValue("full-access");
    expect(screen.getByLabelText("Model")).toHaveValue("gpt-5.6-sol");
    expect(screen.getByLabelText("Reasoning")).toHaveValue("ultra");
    expect(screen.getByLabelText("Fast mode")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Environment")).toHaveTextContent("Codex Environment");
    expect(screen.getByLabelText("Workspace mode")).toHaveValue("worktree");
    expect(screen.getByLabelText("Base branch")).toHaveValue(
      "feature/provider-memory",
    );

    chooseDropdownOption("Provider", "Grok");
    await waitFor(() => {
      expect(screen.getByLabelText("Provider")).toHaveValue("acp:grok");
      expect(screen.getByLabelText("Model")).toHaveValue("grok-4.5-pro");
      expect(screen.getByLabelText("Reasoning")).toHaveValue("medium");
      expect(screen.getByLabelText("Service tier")).toHaveValue("standard");
      expect(screen.getByLabelText("Agent mode")).toHaveValue("yolo");
      expect(screen.getByLabelText("Environment")).toHaveTextContent(
        "Grok Environment",
      );
    });
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
          ...createScheduledActionApi(),
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
    await clickButton("Send");

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
      (_request: StartTurnRequest) =>
        new Promise<StartTurnResponse>((resolve) => {
          resolveStartTurn = resolve;
        })
    );

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
    await clickButton("Send");

    expect(screen.getByRole("button", { name: "Sending…" })).toBeDisabled();
    expect(textarea).toBeEnabled();
    expect(textarea).toHaveValue("");

    await act(async () => {
      resolveStartTurn?.({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      });
    });
  });

  it("restores the reply draft when starting a turn fails after clearing", async () => {
    const startTurn = vi.fn(async () => {
      throw new Error("Start failed");
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
          title: "Failed send",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Restore this draft" } });
    await clickButton("Send");

    await waitFor(() => {
      expect(textarea).toHaveValue("Restore this draft");
      expect(screen.getByText("Start failed")).toBeInTheDocument();
    });
  });

  it("preserves newer reply edits when starting a turn fails after clearing", async () => {
    const startTurnDeferred = createDeferred<StartTurnResponse>();
    const startTurn = vi.fn(() => startTurnDeferred.promise);

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
          title: "Failed send",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Submitted draft" } });
    await clickButton("Send");
    expect(textarea).toHaveValue("");

    fireEvent.change(textarea, { target: { value: "Next draft" } });
    await act(async () => {
      startTurnDeferred.reject(new Error("Start failed"));
    });

    await waitFor(() => {
      expect(textarea).toHaveValue("Next draft");
      expect(screen.getByText("Start failed")).toBeInTheDocument();
    });
  });

  it("queues submits while a turn start is pending", async () => {
    let resolveStartTurn: ((value: StartTurnResponse) => void) | undefined;
    const startTurn = vi.fn(
      (request: StartTurnRequest) => {
        const text = request.input.find((item) => item.type === "text")?.text;
        if (text === "follow up next") {
          return Promise.resolve({
            backend: request.backend,
            threadId: request.threadId,
            turnId: "queue-entry-1",
            queueStatus: "queued" as const,
            queueEntryId: "queue-entry-1",
          });
        }
        return new Promise<StartTurnResponse>((resolve) => {
          resolveStartTurn = () => resolve({
            backend: request.backend,
            threadId: request.threadId,
            turnId: "turn-1",
          });
        });
      },
    );

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
    fireEvent.change(textarea, { target: { value: "did CI pass" } });
    await clickButton("Send");
    fireEvent.change(textarea, { target: { value: "follow up next" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "follow up next",
      );
    });

    await act(async () => {
      resolveStartTurn?.({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      });
    });
  });

  it("schedules the current draft from the send split menu", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-scheduled",
    }));

    render(
      <Composer
        desktopApi={{
          ...createScheduledActionApi(),
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Schedule send",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Check this in a bit" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule message" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Send in 15m" }));
    });

    expect(startTurn).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("");
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Sends in 15m"
    );
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Check this in a bit"
    );
  });

  it("preserves a scheduled send time while editing a scheduled queued draft", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-scheduled",
    }));

    render(
      <Composer
        desktopApi={{
          ...createScheduledActionApi(),
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Edit scheduled send",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Original scheduled text" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule message" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Send in 1h" }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    });
    expect(textarea).toHaveValue("Original scheduled text");
    // The Send button is plain "Send"; the schedule surfaces as an armed
    // toggle beside it rather than a countdown label on Send itself.
    const scheduleToggle = screen.getByRole("switch");
    expect(scheduleToggle).toBeChecked();
    expect(scheduleToggle).toHaveTextContent("in 1h");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();

    fireEvent.change(textarea, { target: { value: "Edited scheduled text" } });
    // Toggle stays armed → Send keeps the schedule (re-queues at the same time).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
    });

    expect(startTurn).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("");
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Sends in 1h"
    );
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Edited scheduled text"
    );
  });

  it("sends now when the schedule toggle is unchecked while editing a scheduled draft", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-scheduled",
    }));

    render(
      <Composer
        desktopApi={{
          ...createScheduledActionApi(),
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Edit scheduled send",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Scheduled text" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule message" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Send in 1h" }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    });
    // Uncheck the schedule so Send fires immediately instead of re-queuing.
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByRole("switch")).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(startTurn.mock.calls[0]![0].input).toEqual([
      { type: "text", text: "Scheduled text" },
    ]);
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    // The toggle is gone once the schedule is consumed.
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("sends a scheduled queued message now via Send now when no turn is active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-scheduled",
    }));
    const scheduledApi = createScheduledActionApi();

    render(
      <Composer
        desktopApi={{
          ...scheduledApi,
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Send scheduled now",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Scheduled for later" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule message" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Send in 1h" }));
    });

    // No active turn → the queued entry offers "Send now", not a dead "Steer".
    expect(screen.queryByRole("button", { name: "Steer" })).not.toBeInTheDocument();
    const sendNow = screen.getByRole("button", { name: "Send now" });

    await act(async () => {
      fireEvent.click(sendNow);
    });

    expect(startTurn).not.toHaveBeenCalled();
    expect(scheduledApi.sendScheduledThreadActionNow).toHaveBeenCalledWith({
      id: "scheduled-1",
    });
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
  });

  it("keeps a scheduled message visible when Send now admits it to the backend queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const scheduledApi = createScheduledActionApi({
      sendNowStatus: "queued",
    });

    render(
      <Composer
        desktopApi={{
          ...scheduledApi,
          onAgentEvent: () => () => undefined,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Queue scheduled now",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Wait behind the active backend turn" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Schedule message" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Send in 1h" }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    });

    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Queued next",
    );
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Wait behind the active backend turn",
    );
    expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
  });

  it("preserves schedule selection through bare review configuration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));

    render(
      <Composer
        desktopApi={{
          ...createScheduledActionApi(),
          onAgentEvent: () => () => undefined,
          startReview,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Scheduled review",
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
    fireEvent.click(screen.getByRole("button", { name: "Schedule message" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send in 30m" }));

    const reviewTarget = screen.getByRole("group", { name: "Review target" });
    expect(reviewTarget).toBeInTheDocument();
    expect(
      within(reviewTarget).getByRole("button", { name: "Send in 30m" })
    ).toBeEnabled();

    await act(async () => {
      fireEvent.click(
        within(reviewTarget).getByRole("button", { name: "Send in 30m" })
      );
    });

    expect(startReview).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Sends in 30m"
    );
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Review changes against main"
    );
  });

  it("hides the schedule toggle while the review-config panel owns the schedule", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview: vi.fn(async (request: StartReviewRequest) => ({
            backend: request.backend,
            threadId: request.threadId,
            reviewThreadId: request.threadId,
            turnId: "turn-review-1",
          })),
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Scheduled review",
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
    fireEvent.click(screen.getByRole("button", { name: "Schedule message" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Send in 30m" }));

    // The review panel owns the scheduled-send button; the main-composer
    // schedule toggle must NOT appear (it doesn't gate the review submit, so
    // it would be a dead control that pretends to unarm the schedule).
    expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("shows a 5h context reset schedule option when the backend exposes a reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-scheduled",
    }));

    render(
      <Composer
        backends={[
          {
            ...backendSummary("codex"),
            rateLimits: [
              {
                name: "5h limit",
                resetAt: Date.now() + 154 * 60_000,
                usedPercent: 80,
              },
            ],
          },
        ]}
        desktopApi={{
          ...createScheduledActionApi(),
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Reset schedule",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "After the reset" } });
    fireEvent.click(screen.getByRole("button", { name: "Schedule message" }));
    await act(async () => {
      fireEvent.click(
        screen.getByRole("menuitem", {
          name: "Send in 2h 34m (5h context reset)",
        })
      );
    });

    expect(startTurn).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Sends in 2h 34m"
    );
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "After the reset"
    );
  });

  it("hides the schedule caret on a launchpad where scheduling does not apply", () => {
    render(
      <Composer
        backends={[backendSummary("codex")]}
        disabled={false}
        launchpad={{
          directoryKey: "directory:/repo/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/repo/PwrAgent",
          backend: "codex",
          executionMode: "default",
          prompt: "Kick off a new thread",
          workMode: "local",
          createdAt: 1,
          updatedAt: 1,
        }}
        skills={[]}
      />
    );

    // The split collapses to a plain Send/Start pill: no caret, no divider.
    expect(
      screen.queryByRole("button", { name: "Schedule message" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start thread" })
    ).toBeInTheDocument();
  });

  it("queues slash review submits while a turn start is pending", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    let resolveStartTurn: ((value: StartTurnResponse) => void) | undefined;
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const startTurn = vi.fn(
      (request: StartTurnRequest) =>
        new Promise<StartTurnResponse>((resolve) => {
          resolveStartTurn = () =>
            resolve({
              backend: request.backend,
              threadId: request.threadId,
              turnId: "turn-1",
            });
        })
    );
    const scheduledApi = createScheduledActionApi();

    const baseProps = {
      backends: [backendSummary("codex")],
      desktopApi: {
        ...scheduledApi,
        onAgentEvent: (callback: NonNullable<DesktopApi["onAgentEvent"]> extends (
          listener: infer Listener,
        ) => unknown
          ? Listener
          : never) => {
          agentEventHandler = callback as typeof agentEventHandler;
          return () => undefined;
        },
        startReview,
        startTurn,
      },
      disabled: false,
      skills: [],
      thread: {
        id: "thread-1",
        title: "Slow send",
        titleSource: "explicit" as const,
        source: "codex" as const,
        executionMode: "default" as const,
        linkedDirectories: [],
        inbox: { inInbox: false },
      },
    };

    const { rerender } = render(<Composer {...baseProps} />);

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "did CI pass" } });
    await clickButton("Send");
    fireEvent.change(textarea, { target: { value: "/review main" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(startReview).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Review changes against main"
      );
    });

    await act(async () => {
      resolveStartTurn?.({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      });
    });
    rerender(<Composer {...baseProps} activeTurnId="turn-1" />);
    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      });
    });

    expect(startReview).not.toHaveBeenCalled();
    expect(scheduledApi.createScheduledThreadAction).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        kind: "review",
        review: expect.objectContaining({
          target: { type: "baseBranch", branch: "main" },
        }),
      }),
    );
  });

  it("keeps the review target picker for bare reviews while a turn start is pending", async () => {
    const startReview = vi.fn();
    const startTurn = vi.fn(
      (request: StartTurnRequest) =>
        new Promise<StartTurnResponse>(() => {
          void request;
        })
    );

    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
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
    fireEvent.change(textarea, { target: { value: "did CI pass" } });
    await clickButton("Send");
    fireEvent.change(textarea, { target: { value: "/review" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(startReview).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();
    expect(screen.queryByText("Queued next")).not.toBeInTheDocument();
  });

  it("submits Enter during an active turn and keeps a queued projection", async () => {
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "queue-entry-1",
      queueStatus: "queued" as const,
      queueEntryId: "queue-entry-1",
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

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: [{ type: "text", text: "Follow up next" }],
        }),
      );
      expect(screen.getByText("Queued next")).toBeInTheDocument();
      expect(screen.getByText("Follow up next")).toBeInTheDocument();
    });
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

  it("queues Enter while the selected thread is busy before an active turn id arrives", async () => {
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "queue-entry-1",
      queueStatus: "queued" as const,
      queueEntryId: "queue-entry-1",
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
        title: "Busy thread",
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
        threadBusy
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Follow up after thinking" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: [{ type: "text", text: "Follow up after thinking" }],
        }),
      );
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Follow up after thinking",
      );
    });
    expect(textarea).toHaveValue("");

    rerender(<Composer {...baseProps} threadBusy={false} />);

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-1",
          input: [{ type: "text", text: "Follow up after thinking" }],
        })
      );
    });
  });

  it("keeps active-turn messages in oldest-first queue order", async () => {
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: `queue-entry-${startTurn.mock.calls.length}`,
      queueStatus: "queued" as const,
      queueEntryId: `queue-entry-${startTurn.mock.calls.length}`,
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
    fireEvent.change(textarea, { target: { value: "First queued reply" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "Second queued reply" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "First queued reply",
      );
      expect(screen.getByLabelText("Queued message 2")).toHaveTextContent(
        "Second queued reply",
      );
      expect(
        screen.getAllByRole("button", { name: "Edit" })[0],
      ).toBeEnabled();
    });
    expect(screen.queryByText("A message is already queued.")).not.toBeInTheDocument();

    rerender(<Composer {...baseProps} activeTurnId={undefined} />);

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-1",
          input: [{ type: "text", text: "First queued reply" }],
        })
      );
    });
    expect(startTurn).toHaveBeenCalledTimes(2);
  });

  it("keeps the second queued turn waiting after the first queued turn dispatches", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: `queue-entry-${startTurn.mock.calls.length}`,
      queueStatus: "queued" as const,
      queueEntryId: `queue-entry-${startTurn.mock.calls.length}`,
    }));
    const baseProps = {
      backends: [backendSummary("codex")],
      desktopApi: {
        onAgentEvent: (callback: NonNullable<DesktopApi["onAgentEvent"]> extends (
          listener: infer Listener,
        ) => unknown
          ? Listener
          : never) => {
          agentEventHandler = callback as typeof agentEventHandler;
          return () => undefined;
        },
        startTurn,
      },
      disabled: false,
      skills: [],
      thread: {
        id: "thread-1",
        title: "Stacked queue",
        titleSource: "explicit" as const,
        source: "codex" as const,
        executionMode: "default" as const,
        linkedDirectories: [],
        inbox: { inInbox: false },
      },
    };

    const { rerender } = render(
      <StrictMode>
        <Composer {...baseProps} activeTurnId="turn-1" />
      </StrictMode>
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "First queued turn" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "Second queued turn" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "First queued turn",
      );
      expect(screen.getByLabelText("Queued message 2")).toHaveTextContent(
        "Second queued turn",
      );
    });

    rerender(
      <StrictMode>
        <Composer {...baseProps} activeTurnId={undefined} />
      </StrictMode>
    );

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(2);
    });
    await flushReactUpdates();

    expect(startTurn).toHaveBeenCalledTimes(2);

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      });
    });
    await flushReactUpdates();

    expect(startTurn).toHaveBeenCalledTimes(2);
  });

  it("only releases one queued turn when duplicate focused composers share a queue", async () => {
    const draftStore = createComposerDraftStore();
    const thread = {
      id: "thread-1",
      title: "Duplicate queue owner",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const scopeKey = "thread:codex:thread-1";
    draftStore.setQueuedTurns(scopeKey, [
      {
        id: "queued-1",
        text: "First duplicate-owned turn",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "First duplicate-owned turn" }],
      },
      {
        id: "queued-2",
        text: "Second duplicate-owned turn",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "Second duplicate-owned turn" }],
      },
      {
        id: "queued-3",
        text: "Third duplicate-owned turn",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "Third duplicate-owned turn" }],
      },
    ]);
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: `turn-${startTurn.mock.calls.length + 1}`,
    }));
    const baseProps = {
      backends: [backendSummary("codex")],
      desktopApi: {
        onAgentEvent: () => () => undefined,
        startTurn,
      },
      disabled: false,
      draftStore,
      skills: [],
      thread,
    };

    render(
      <>
        <Composer {...baseProps} />
        <Composer {...baseProps} />
      </>
    );

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
    });
    await flushReactUpdates();

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(draftStore.getQueuedTurns(scopeKey).map((entry) => entry.text)).toEqual([
      "Second duplicate-owned turn",
      "Third duplicate-owned turn",
    ]);
  });

  it("releases the queued-turn lock when a queued review start fails", async () => {
    const draftStore = createComposerDraftStore();
    const scopeKey = "thread:codex:thread-1";
    draftStore.setQueuedTurns(scopeKey, [
      {
        id: "queued-review",
        text: "/review main",
        imageAttachments: [],
        fileAttachments: [],
        reviewCommand: {
          displayText: "Review changes against main",
          target: { type: "baseBranch", branch: "main" },
        },
      },
      {
        id: "queued-turn",
        text: "Run after failed review",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "Run after failed review" }],
      },
    ]);
    const startReview = vi.fn(async () => {
      throw new Error("review unavailable");
    });
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-after-review",
    }));

    render(
      <Composer
        backends={[
          {
            ...backendSummary("codex"),
            capabilities: {
              ...backendSummary("codex").capabilities,
              startReview: true,
            },
            methods: ["thread/start", "turn/start", "review/start"],
          },
        ]}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
          startTurn,
        }}
        disabled={false}
        draftStore={draftStore}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Failed queued review",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledTimes(1);
    });
    expect(startTurn).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          input: [{ type: "text", text: "Run after failed review" }],
        })
      );
    });
  });

  it("keeps a queued review local when the previous queued turn lands in the server queue", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "server-queue-entry-1",
      queueStatus: "queued" as const,
      queueEntryId: "server-queue-entry-1",
    }));
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const scheduledApi = createScheduledActionApi();
    const baseProps = {
      backends: [backendSummary("codex")],
      desktopApi: {
        ...scheduledApi,
        onAgentEvent: (callback: NonNullable<DesktopApi["onAgentEvent"]> extends (
          listener: infer Listener,
        ) => unknown
          ? Listener
          : never) => {
          agentEventHandler = callback as typeof agentEventHandler;
          return () => undefined;
        },
        startReview,
        startTurn,
      },
      disabled: false,
      skills: [],
      thread: {
        id: "thread-1",
        title: "Server queue race",
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
    fireEvent.change(textarea, { target: { value: "make a branch and PR" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "make a branch and PR",
      );
    });
    fireEvent.change(textarea, { target: { value: "/review main" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message 2")).toHaveTextContent(
        "Review changes against main",
      );
    });

    rerender(<Composer {...baseProps} activeTurnId={undefined} />);

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-1",
          input: [{ type: "text", text: "make a branch and PR" }],
        })
      );
    });
    await flushReactUpdates();

    expect(startReview).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "make a branch and PR",
    );
    expect(screen.getByLabelText("Queued message 2")).toHaveTextContent(
      "Review changes against main",
    );

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/turnQueue/updated",
          params: {
            threadId: "thread-1",
            queueEntryId: "server-queue-entry-1",
            status: "started",
            turnId: "turn-2",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-2",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/turnQueue/updated",
          params: {
            threadId: "thread-1",
            queueEntryId: "server-queue-entry-1",
            status: "terminal",
            turnId: "turn-2",
          },
        },
      });
    });

    expect(startReview).not.toHaveBeenCalled();
    expect(scheduledApi.createScheduledThreadAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "review" }),
    );
  });

  it("resets server queued turn state when switching composer scopes", async () => {
    const startTurn = vi.fn(async (request: StartTurnRequest) => {
      if (request.threadId === "thread-1") {
        return {
          backend: request.backend,
          threadId: request.threadId,
          turnId: "server-queue-entry-1",
          queueStatus: "queued" as const,
          queueEntryId: "server-queue-entry-1",
        };
      }

      return {
        backend: request.backend,
        threadId: request.threadId,
        turnId: "turn-thread-2",
      };
    });
    const baseProps = {
      backends: [backendSummary("codex")],
      desktopApi: {
        onAgentEvent: () => () => undefined,
        startTurn,
      },
      disabled: false,
      skills: [],
    };
    const threadA = {
      id: "thread-1",
      title: "Server queued thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const threadB = {
      ...threadA,
      id: "thread-2",
      title: "Other thread",
    };

    const { rerender } = render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
        thread={threadA}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "make a branch and PR" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    rerender(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={threadA}
      />
    );

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          input: [{ type: "text", text: "make a branch and PR" }],
        })
      );
    });
    await flushReactUpdates();

    rerender(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={threadB}
      />
    );

    const nextTextarea = screen.getByLabelText("Reply");
    fireEvent.change(nextTextarea, { target: { value: "work on thread two" } });
    await clickButton("Send");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-2",
          input: [{ type: "text", text: "work on thread two" }],
        })
      );
    });
  });

  it("remembers server queued turn state after switching away and back", async () => {
    const draftStore = createComposerDraftStore();
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "server-queue-entry-1",
      queueStatus: "queued" as const,
      queueEntryId: "server-queue-entry-1",
    }));
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const scheduledApi = createScheduledActionApi();
    const baseProps = {
      backends: [backendSummary("codex")],
      desktopApi: {
        ...scheduledApi,
        onAgentEvent: () => () => undefined,
        startReview,
        startTurn,
      },
      disabled: false,
      draftStore,
      skills: [],
    };
    const threadA = {
      id: "thread-1",
      title: "Server queued thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const threadB = {
      ...threadA,
      id: "thread-2",
      title: "Other thread",
    };

    const { rerender } = render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
        thread={threadA}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "make a branch and PR" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "/review main" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message 2")).toHaveTextContent(
        "Review changes against main",
      );
    });

    rerender(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={threadA}
      />
    );

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          input: [{ type: "text", text: "make a branch and PR" }],
        })
      );
    });
    await flushReactUpdates();
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "make a branch and PR",
    );
    expect(screen.getByLabelText("Queued message 2")).toHaveTextContent(
      "Review changes against main",
    );

    rerender(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={threadB}
      />
    );
    rerender(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={threadA}
      />
    );
    await flushReactUpdates();

    expect(startReview).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Queue" })).toBeInTheDocument();
    expect(screen.getByLabelText("Queued message 2")).toHaveTextContent(
      "Review changes against main",
    );
  });

  it("keeps backend-owned queue state when switching through an empty composer", async () => {
    const draftStore = createComposerDraftStore();
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "server-queue-entry-1",
      queueStatus: "queued" as const,
      queueEntryId: "server-queue-entry-1",
    }));
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const scheduledApi = createScheduledActionApi();
    const baseProps = {
      backends: [backendSummary("codex")],
      desktopApi: {
        ...scheduledApi,
        onAgentEvent: () => () => undefined,
        startReview,
        startTurn,
      },
      disabled: false,
      draftStore,
      skills: [],
    };
    const thread = {
      id: "thread-1",
      title: "Server queued thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };

    const { rerender } = render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
        thread={thread}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "make a branch and PR" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "/review main" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message 2")).toHaveTextContent(
        "Review changes against main",
      );
    });

    rerender(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={thread}
      />
    );

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          threadId: "thread-1",
          input: [{ type: "text", text: "make a branch and PR" }],
        })
      );
    });
    await flushReactUpdates();
    expect(startReview).not.toHaveBeenCalled();

    rerender(<Composer {...baseProps} activeTurnId={undefined} />);
    rerender(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={thread}
      />
    );

    await flushReactUpdates();
    expect(startReview).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "make a branch and PR",
    );
    expect(screen.getByLabelText("Queued message 2")).toHaveTextContent(
      "Review changes against main",
    );
  });

  it("clears backend queue UI when a queued turn fails before starting", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "server-queue-entry-1",
      queueStatus: "queued" as const,
      queueEntryId: "server-queue-entry-1",
    }));
    const addOptimisticUserMessage = vi.fn(() => "optimistic-1");
    const removeOptimisticMessage = vi.fn();
    const onPendingStatusChange = vi.fn();
    const baseProps = {
      backends: [backendSummary("codex")],
      desktopApi: {
        onAgentEvent: (callback: NonNullable<DesktopApi["onAgentEvent"]> extends (
          listener: infer Listener,
        ) => unknown
          ? Listener
          : never) => {
          agentEventHandler = callback as typeof agentEventHandler;
          return () => undefined;
        },
        startTurn,
      },
      addOptimisticUserMessage,
      disabled: false,
      onPendingStatusChange,
      removeOptimisticMessage,
      skills: [],
      thread: {
        id: "thread-1",
        title: "Server queued thread",
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
    fireEvent.change(textarea, { target: { value: "make a branch and PR" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    rerender(<Composer {...baseProps} activeTurnId={undefined} />);

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "make a branch and PR",
      );
    });
    expect(addOptimisticUserMessage).not.toHaveBeenCalled();
    expect(onPendingStatusChange).not.toHaveBeenCalledWith("Thinking");

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/turnQueue/updated",
          params: {
            threadId: "thread-1",
            queueEntryId: "server-queue-entry-1",
            status: "failed",
            errorMessage: "Thread queue start failed",
          },
        },
      });
    });

    expect(removeOptimisticMessage).not.toHaveBeenCalled();
    expect(onPendingStatusChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByText("Thread queue start failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("does not remove the next queued message when the in-flight queued chip is edited", async () => {
    const startTurn = vi.fn(async (request: StartTurnRequest) => {
      const queueEntryId = `queue-entry-${startTurn.mock.calls.length}`;
      return {
        backend: request.backend,
        threadId: request.threadId,
        turnId: queueEntryId,
        queueStatus: "queued" as const,
        queueEntryId,
      };
    });
    const cancelQueuedTurn = vi.fn(async ({ queueEntryId }: {
      queueEntryId: string;
    }) => ({ queueEntryId, cancelled: true }));
    const baseProps = {
      backends: [backendSummary("codex")],
      desktopApi: {
        cancelQueuedTurn,
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

    render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "First queued reply" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "Second queued reply" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "First queued reply",
      );
      expect(screen.getByLabelText("Queued message 2")).toHaveTextContent(
        "Second queued reply",
      );
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[0]!);

    await waitFor(() => {
      expect(cancelQueuedTurn).toHaveBeenCalledWith({
        queueEntryId: "queue-entry-1",
      });
      expect(screen.getByLabelText("Reply")).toHaveValue("First queued reply");
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Second queued reply",
      );
    });
  });

  it("cancels the owning peer's queued turn before remote steering", async () => {
    const federationTarget = {
      scope: "remote" as const,
      instanceId: "remote-instance",
    };
    const cancelQueuedTurn = vi.fn(async ({ queueEntryId }: {
      queueEntryId: string;
    }) => ({ queueEntryId, cancelled: true }));
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
            ...backendSummary("codex"),
            capabilities: {
              ...backendSummary("codex").capabilities,
              steerTurn: true,
            },
          },
        ]}
        desktopApi={{
          cancelQueuedTurn,
          onAgentEvent: () => () => undefined,
          startTurn: vi.fn(async () => ({
            backend: "codex" as const,
            threadId: "thread-1",
            turnId: "queue-entry-1",
            queueStatus: "queued" as const,
            queueEntryId: "queue-entry-1",
          })),
          steerTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Remote active turn",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          federation: {
            ref: {
              backend: "codex",
              target: federationTarget,
              threadId: "thread-1",
            },
            instanceLabel: "Remote",
            peerStatus: "connected",
          },
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />,
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Steer remotely" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByLabelText("Queued message");
    const steerButton = screen.getByRole("button", { name: "Steer" });
    // The local projection renders immediately but remains disabled until the
    // owning peer returns its stable queue entry id. A click before that
    // acknowledgement is intentionally ignored.
    await waitFor(() => {
      expect(steerButton).toBeEnabled();
    });
    fireEvent.click(steerButton);

    await waitFor(() => {
      expect(cancelQueuedTurn).toHaveBeenCalledWith({
        federationTarget,
        queueEntryId: "queue-entry-1",
      });
      expect(steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({ federationTarget }),
      );
    });
  });

  it("removes concurrently cancelled queue entries by stable id", async () => {
    const cancellationOne = createDeferred<{
      queueEntryId: string;
      cancelled: boolean;
    }>();
    const cancellationTwo = createDeferred<{
      queueEntryId: string;
      cancelled: boolean;
    }>();
    const startTurn = vi.fn(async (request: StartTurnRequest) => {
      const queueEntryId = `queue-entry-${startTurn.mock.calls.length}`;
      return {
        backend: request.backend,
        threadId: request.threadId,
        turnId: queueEntryId,
        queueStatus: "queued" as const,
        queueEntryId,
      };
    });
    const cancelQueuedTurn = vi.fn(({ queueEntryId }: {
      queueEntryId: string;
    }) => queueEntryId === "queue-entry-1"
      ? cancellationOne.promise
      : cancellationTwo.promise);

    render(
      <Composer
        activeTurnId="turn-1"
        backends={[backendSummary("codex")]}
        desktopApi={{
          cancelQueuedTurn,
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Active turn",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />,
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "First queued reply" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "Second queued reply" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      const buttons = screen.getAllByRole("button", { name: "Delete" });
      expect(buttons).toHaveLength(2);
      expect(buttons[0]).toBeEnabled();
      expect(buttons[1]).toBeEnabled();
    });
    const deleteButtons = screen.getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[0]!);
    fireEvent.click(deleteButtons[1]!);

    await act(async () => {
      cancellationOne.resolve({
        queueEntryId: "queue-entry-1",
        cancelled: true,
      });
      await cancellationOne.promise;
    });
    await act(async () => {
      cancellationTwo.resolve({
        queueEntryId: "queue-entry-2",
        cancelled: true,
      });
      await cancellationTwo.promise;
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    });
    expect(cancelQueuedTurn).toHaveBeenCalledTimes(2);
  });

  it("restores a queued active-turn message after navigating away and back", async () => {
    const draftStore = createComposerDraftStore();
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "queue-entry-1",
      queueStatus: "queued" as const,
      queueEntryId: "queue-entry-1",
    }));
    const baseProps = {
      backends: [backendSummary("codex")],
      desktopApi: {
        cancelQueuedTurn: vi.fn(async ({ queueEntryId }) => ({
          queueEntryId,
          cancelled: true,
        })),
        onAgentEvent: () => () => undefined,
        startTurn,
      },
      disabled: false,
      draftStore,
      skills: [],
    };
    const threadA = {
      id: "thread-1",
      title: "Active turn",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const threadB = {
      ...threadA,
      id: "thread-2",
      title: "Another thread",
    };

    const { unmount } = render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
        thread={threadA}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Keep this queued reply" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Keep this queued reply",
      );
    });

    unmount();
    const { unmount: unmountThreadB } = render(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={threadB}
      />
    );
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();

    unmountThreadB();
    const { unmount: unmountRestoredThreadA } = render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
        thread={threadA}
      />
    );

    expect(screen.getByLabelText("Queued message")).toHaveTextContent(
      "Keep this queued reply"
    );
    expect(startTurn).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
    });

    unmountRestoredThreadA();
    render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
        thread={threadA}
      />
    );
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
  });

  it("shows queued image thumbnails while a turn is active", async () => {
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "queue-entry-1",
      queueStatus: "queued" as const,
      queueEntryId: "queue-entry-1",
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
    await clickButton("Queue");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Queued next")).toBeInTheDocument();
      expect(screen.getByText("1 image")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Queued image attachments: 1"),
      ).toBeInTheDocument();
      expect(screen.getByAltText("queued.png")).toBeInTheDocument();
    });
  });

  it("submits a busy-thread queued reply to the backend before navigation", async () => {
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "queue-entry-1",
      queueStatus: "queued" as const,
      queueEntryId: "queue-entry-1",
    }));

    const { unmount } = render(
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
          title: "Active turn",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Run after this turn" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-1",
          input: [{ type: "text", text: "Run after this turn" }],
        }),
      );
    });

    unmount();
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("keeps a delayed backend queue acknowledgement scoped to its thread", async () => {
    const draftStore = createComposerDraftStore();
    const startTurnDeferred = createDeferred<StartTurnResponse>();
    const startTurn = vi.fn(() => startTurnDeferred.promise);
    const threadA: NavigationThreadSummary = {
      id: "thread-1",
      title: "Active turn",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const threadB: NavigationThreadSummary = {
      ...threadA,
      id: "thread-2",
      title: "Other thread",
    };
    const baseProps = {
      desktopApi: {
        onAgentEvent: () => () => undefined,
        startTurn,
      },
      disabled: false,
      draftStore,
      skills: [],
    };

    const { rerender } = render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
        thread={threadA}
      />,
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Stay with thread A" },
    });
    fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter" });

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Stay with thread A")).toBeInTheDocument();
    });

    rerender(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={threadB}
      />,
    );
    expect(screen.queryByText("Stay with thread A")).not.toBeInTheDocument();

    await act(async () => {
      startTurnDeferred.resolve({
        backend: "codex",
        threadId: "thread-1",
        turnId: "queue-entry-1",
        queueStatus: "queued",
        queueEntryId: "queue-entry-1",
      });
      await startTurnDeferred.promise;
    });

    expect(screen.queryByText("Stay with thread A")).not.toBeInTheDocument();
    expect(draftStore.getQueuedTurns("thread:codex:thread-2")).toEqual([]);
    expect(
      draftStore.getQueuedTurn("thread:codex:thread-1"),
    ).toMatchObject({
      queueEntryId: "queue-entry-1",
      text: "Stay with thread A",
    });

    rerender(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
        thread={threadA}
      />,
    );
    expect(screen.getByText("Stay with thread A")).toBeInTheDocument();
  });

  it("does not apply a delayed started response to another thread", async () => {
    const draftStore = createComposerDraftStore();
    const startTurnDeferred = createDeferred<StartTurnResponse>();
    const startTurn = vi.fn(() => startTurnDeferred.promise);
    const addOptimisticUserMessage = vi.fn(() => "optimistic-a");
    const onActiveTurnIdChange = vi.fn();
    const threadA: NavigationThreadSummary = {
      id: "thread-1",
      title: "Active turn",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const threadB: NavigationThreadSummary = {
      ...threadA,
      id: "thread-2",
      title: "Other thread",
    };
    const baseProps = {
      addOptimisticUserMessage,
      desktopApi: {
        onAgentEvent: () => () => undefined,
        startTurn,
      },
      disabled: false,
      draftStore,
      onActiveTurnIdChange,
      skills: [],
    };
    const { rerender } = render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
        thread={threadA}
      />,
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Start for thread A" },
    });
    fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter" });
    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));

    rerender(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={threadB}
      />,
    );

    await act(async () => {
      startTurnDeferred.resolve({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-a",
      });
      await startTurnDeferred.promise;
    });

    expect(onActiveTurnIdChange).not.toHaveBeenCalledWith("turn-a");
    expect(addOptimisticUserMessage).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("restores a rejected delayed submission to its original thread", async () => {
    const draftStore = createComposerDraftStore();
    const startTurnDeferred = createDeferred<StartTurnResponse>();
    const startTurn = vi.fn(() => startTurnDeferred.promise);
    const threadA: NavigationThreadSummary = {
      id: "thread-1",
      title: "Active turn",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const threadB: NavigationThreadSummary = {
      ...threadA,
      id: "thread-2",
      title: "Other thread",
    };
    const baseProps = {
      desktopApi: {
        onAgentEvent: () => () => undefined,
        startTurn,
      },
      disabled: false,
      draftStore,
      skills: [],
    };
    const { rerender } = render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
        thread={threadA}
      />,
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Recover for thread A" },
    });
    fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter" });
    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(1));

    rerender(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={threadB}
      />,
    );
    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Keep thread B draft" },
    });

    await act(async () => {
      startTurnDeferred.reject(new Error("thread A start failed"));
      await startTurnDeferred.promise.catch(() => undefined);
    });

    expect(screen.getByLabelText("Reply")).toHaveValue("Keep thread B draft");
    expect(screen.queryByText("thread A start failed")).not.toBeInTheDocument();
    expect(draftStore.get("thread:codex:thread-1")).toMatchObject({
      draft: "Recover for thread A",
    });
  });

  it("preserves a cancelled queued item when its steer target changes", async () => {
    const draftStore = createComposerDraftStore();
    draftStore.setQueuedTurn("thread:codex:thread-1", {
      id: "queued-steer-1",
      scheduledActionId: "scheduled-action-1",
      text: "Steer the original turn",
      imageAttachments: [],
      fileAttachments: [],
      input: [{ type: "text", text: "Steer the original turn" }],
    });
    const cancellation = createDeferred<{
      action: ScheduledThreadAction;
    }>();
    const cancelScheduledThreadAction = vi.fn(() => cancellation.promise);
    const steerTurn = vi.fn();
    const baseProps = {
      backends: [
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
      ],
      desktopApi: {
        cancelScheduledThreadAction,
        onAgentEvent: () => () => undefined,
        steerTurn,
      },
      disabled: false,
      draftStore,
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
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    expect(cancelScheduledThreadAction).toHaveBeenCalledWith({
      federationTarget: undefined,
      id: "scheduled-action-1",
    });

    rerender(
      <Composer
        {...baseProps}
        activeTurnId="turn-2"
      />,
    );
    await act(async () => {
      cancellation.resolve({
        action: {
          id: "scheduled-action-1",
          backend: "codex",
          threadId: "thread-1",
          kind: "turn",
          origin: "desktop",
          status: "cancelled",
          scheduledFor: 1_000,
          displayText: "Steer the original turn",
          turn: {
            input: [{ type: "text", text: "Steer the original turn" }],
          },
          createdAt: 1_000,
          updatedAt: 2_000,
        },
      });
      await cancellation.promise;
    });

    expect(steerTurn).not.toHaveBeenCalled();
    expect(screen.getByText("Steer the original turn")).toBeInTheDocument();
    expect(
      draftStore.getQueuedTurn("thread:codex:thread-1"),
    ).toMatchObject({
      id: "queued-steer-1",
      text: "Steer the original turn",
    });
    expect(
      draftStore.getQueuedTurn("thread:codex:thread-1")?.scheduledActionId,
    ).toBeUndefined();
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

    await waitFor(() => {
      expect(steerTurn).toHaveBeenCalledWith(expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Change direction" }],
        requestId: expect.any(String),
      }));
    });
    expect(screen.getByText("Steering now")).toBeInTheDocument();
    expect(screen.getByText("Change direction")).toBeInTheDocument();
    expect(textarea).toHaveValue("");
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

  it("clears an image-only pending steer after Codex acknowledges the image", async () => {
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
    const imageFile = new File([new Uint8Array([1, 2, 3])], "steer.png", {
      type: "image/png",
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
    fireEvent.paste(textarea, {
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

    expect(await screen.findByAltText("steer.png")).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(screen.getByLabelText("Pending steer message")).toHaveTextContent(
      "1 image"
    );

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
      expect(steerTurn).toHaveBeenCalledWith(expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [
          {
            type: "image",
            name: "steer.png",
            url: expect.stringMatching(/^data:image\/png;base64,/),
          },
        ],
        requestId: expect.any(String),
      }));
    });
    expect(screen.getByText("Steering now")).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: {
              type: "userMessage",
              content: [
                {
                  type: "image",
                  url: "data:image/png;base64,AQID",
                },
              ],
            },
          },
        },
      });
    });

    expect(
      screen.queryByLabelText("Pending steer message")
    ).not.toBeInTheDocument();
  });

  it("does not retry an in-flight steer after navigating away and back", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const draftStore = createComposerDraftStore();
    const steerTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    const baseProps = {
      activeTurnId: "turn-1",
      backends: [
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
      ],
      desktopApi: {
        onAgentEvent: (callback: unknown) => {
          agentEventHandler = callback as typeof agentEventHandler;
          return () => undefined;
        },
        steerTurn,
      },
      disabled: false,
      draftStore,
      skills: [],
    };
    const threadA = {
      id: "thread-1",
      title: "Steerable thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const threadB = {
      ...threadA,
      id: "thread-2",
      title: "Another thread",
    };

    const { unmount } = render(
      <Composer
        {...baseProps}
        thread={threadA}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Keep steering direction" } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });

    expect(screen.getByLabelText("Pending steer message")).toHaveTextContent(
      "Keep steering direction",
    );
    expect(steerTurn).toHaveBeenCalledTimes(1);

    unmount();
    const { unmount: unmountThreadB } = render(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={threadB}
      />
    );
    expect(screen.queryByLabelText("Pending steer message")).not.toBeInTheDocument();

    unmountThreadB();
    render(
      <Composer
        {...baseProps}
        thread={threadA}
      />
    );

    expect(
      screen.queryByLabelText("Pending steer message")
    ).not.toBeInTheDocument();
    expect(steerTurn).toHaveBeenCalledTimes(1);

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: {
              type: "tool_call",
              output: "ready for steering",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(steerTurn).toHaveBeenCalledWith(expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Keep steering direction" }],
        requestId: expect.any(String),
      }));
    });
    expect(steerTurn).toHaveBeenCalledTimes(1);
  });

  it("does not retry an in-flight steer after switching thread props", async () => {
    const draftStore = createComposerDraftStore();
    const steerTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    const baseProps = {
      activeTurnId: "turn-1",
      backends: [
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
      ],
      desktopApi: {
        onAgentEvent: () => () => undefined,
        steerTurn,
      },
      disabled: false,
      draftStore,
      skills: [],
    };
    const threadA = {
      id: "thread-1",
      title: "Steerable thread",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const threadB = {
      ...threadA,
      id: "thread-2",
      title: "Another thread",
    };

    const { rerender } = render(
      <Composer
        {...baseProps}
        thread={threadA}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Keep steering through prop navigation" },
    });
    fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter", metaKey: true });

    expect(screen.getByLabelText("Pending steer message")).toHaveTextContent(
      "Keep steering through prop navigation"
    );

    rerender(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
        thread={threadB}
      />
    );
    expect(screen.queryByLabelText("Pending steer message")).not.toBeInTheDocument();

    rerender(
      <Composer
        {...baseProps}
        thread={threadA}
      />
    );

    expect(
      screen.queryByLabelText("Pending steer message")
    ).not.toBeInTheDocument();
    expect(steerTurn).toHaveBeenCalledTimes(1);
  });

  it("does not turn an already-dispatched steer into a new turn after navigation", async () => {
    const draftStore = createComposerDraftStore();
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-2",
    }));
    const steerTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    const baseProps = {
      backends: [
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
      ],
      desktopApi: {
        onAgentEvent: () => () => undefined,
        startTurn,
        steerTurn,
      },
      disabled: false,
      draftStore,
      skills: [],
      thread: {
        id: "thread-1",
        title: "Steerable thread",
        titleSource: "explicit" as const,
        source: "codex" as const,
        executionMode: "default" as const,
        linkedDirectories: [],
        inbox: { inInbox: false },
      },
    };

    const { unmount } = render(
      <Composer
        {...baseProps}
        activeTurnId="turn-1"
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Continue after active turn" },
    });
    fireEvent.keyDown(screen.getByLabelText("Reply"), { key: "Enter", metaKey: true });

    expect(screen.getByLabelText("Pending steer message")).toHaveTextContent(
      "Continue after active turn"
    );
    expect(startTurn).not.toHaveBeenCalled();
    expect(steerTurn).toHaveBeenCalledTimes(1);

    unmount();
    render(
      <Composer
        {...baseProps}
        activeTurnId={undefined}
      />
    );

    await flushReactUpdates();
    expect(startTurn).not.toHaveBeenCalled();
    expect(steerTurn).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Pending steer message")).not.toBeInTheDocument();
  });

  it("keeps a pending steer local-file reference when a terminal event queues it", async () => {
    const draftStore = createComposerDraftStore();
    draftStore.setPendingSteer("thread:codex:thread-1", {
      id: "pending-jeep",
      expectedTurnId: "turn-1",
      input: [
        { type: "text", text: "Compare [@Jeep](~/Downloads/Jeep)" },
        {
          type: "localFile",
          name: "Jeep",
          path: "/Users/huntharo/Downloads/Jeep",
          pdfRenderProfile: "high",
        },
      ],
      text: "Compare [@Jeep](~/Downloads/Jeep)",
      imageAttachments: [],
      fileAttachments: [],
    });
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const scheduledApi = createScheduledActionApi();
    const steerTurn = vi.fn(async (request: SteerTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: request.expectedTurnId,
      disposition: "scheduled" as const,
      scheduledAction: {
        id: "scheduled-steer-1",
        backend: request.backend,
        threadId: request.threadId,
        kind: "turn" as const,
        origin: "desktop" as const,
        status: "scheduled" as const,
        scheduledFor: Date.now(),
        displayText: request.fallback?.displayText ?? "",
        turn: request.fallback?.turn,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));

    render(
      <Composer
        activeTurnId="turn-1"
        backends={[backendSummary("codex")]}
        desktopApi={{
          ...scheduledApi,
          steerTurn,
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
        }}
        disabled={false}
        draftStore={draftStore}
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
      />,
    );

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed" },
          },
        },
      });
    });

    await waitFor(() => {
      expect(steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          fallback: expect.objectContaining({
            turn: expect.objectContaining({
            input: [
              { type: "text", text: "Compare [@Jeep](~/Downloads/Jeep)" },
              {
                type: "localFile",
                name: "Jeep",
                path: "/Users/huntharo/Downloads/Jeep",
                pdfRenderProfile: "high",
              },
            ],
            }),
          }),
        }),
      );
      expect(scheduledApi.createScheduledThreadAction).not.toHaveBeenCalled();
    });
  });

  it("hydrates a restored queued PDF reference before releasing it", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const draftStore = createComposerDraftStore();
      draftStore.setQueuedTurn("thread:codex:thread-1", {
        id: "queued-jeep",
        input: [{ type: "text", text: "Compare [@Jeep](~/Downloads/Jeep)" }],
        text: "Compare [@Jeep](~/Downloads/Jeep)",
        imageAttachments: [],
        fileAttachments: [],
      });
      const inspectPdfReferencePaths = vi.fn(async () => ({
        filePaths: ["/Users/huntharo/Downloads/Jeep"],
        pdfPaths: ["/Users/huntharo/Downloads/Jeep"],
      }));
      const startTurn = vi.fn(async (request: StartTurnRequest) => ({
        backend: request.backend,
        threadId: request.threadId,
        turnId: "turn-2",
      }));

      render(
        <Composer
          desktopApi={{
            inspectPdfReferencePaths,
            onAgentEvent: () => () => undefined,
            startTurn,
          }}
          disabled={false}
          draftStore={draftStore}
          skills={[]}
          thread={{
            id: "thread-1",
            title: "Queued window sticker",
            titleSource: "explicit",
            source: "codex",
            executionMode: "default",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />,
      );

      await waitFor(() => {
        expect(startTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            input: [
              { type: "text", text: "Compare [@Jeep](~/Downloads/Jeep)" },
              {
                type: "localFile",
                name: "Jeep",
                path: "/Users/huntharo/Downloads/Jeep",
              },
            ],
          }),
        );
      });
      expect(inspectPdfReferencePaths).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("hands steering to the backend before the draft can be reclaimed", async () => {
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

    expect(screen.getByText("Steering now")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(textarea).toHaveValue("");
    expect(steerTurn).toHaveBeenCalledTimes(1);
  });

  it("rehydrates local PDF previews when queued and steer drafts return to Composer", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const draftStore = createComposerDraftStore();
      draftStore.setQueuedTurn("thread:codex:thread-1", {
        id: "queued-jeep",
        input: [{ type: "text", text: "Compare [@QueuedJeep](~/Downloads/Jeep)" }],
        text: "Compare [@QueuedJeep](~/Downloads/Jeep)",
        imageAttachments: [],
        fileAttachments: [],
      });
      draftStore.setPendingSteer("thread:codex:thread-1", {
        id: "steer-jeep",
        expectedTurnId: "turn-1",
        input: [{ type: "text", text: "Compare [@SteerJeep](~/Downloads/Jeep)" }],
        text: "Compare [@SteerJeep](~/Downloads/Jeep)",
        imageAttachments: [],
        fileAttachments: [],
      });
      const inspectPdfReferencePaths = vi.fn(async () => ({
        filePaths: ["/Users/huntharo/Downloads/Jeep"],
        pdfPaths: ["/Users/huntharo/Downloads/Jeep"],
      }));
      const renderComposerPdfPreview = vi
        .fn()
        .mockResolvedValueOnce({
          dataUrl: "data:image/png;base64,UEZERg==",
          fileIdentity: "queued-pdf-v1",
          height: 480,
          pageCount: 1,
          unchanged: false as const,
          width: 360,
        })
        .mockResolvedValueOnce({
          fileIdentity: "queued-pdf-v1",
          unchanged: true as const,
        });

      render(
        <Composer
          activeTurnId="turn-1"
          desktopApi={{
            inspectPdfReferencePaths,
            onAgentEvent: () => () => undefined,
            renderComposerPdfPreview,
          }}
          disabled={false}
          draftStore={draftStore}
          skills={[]}
          thread={{
            id: "thread-1",
            title: "Steerable thread",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />,
      );

      fireEvent.click(
        within(screen.getByLabelText("Queued message")).getByRole("button", {
          name: "Edit",
        }),
      );

      await waitFor(() => {
        expect(inspectPdfReferencePaths).toHaveBeenCalledWith({
          paths: ["/Users/huntharo/Downloads/Jeep"],
        });
        expect(
          within(screen.getByTestId("composer-tiptap-input"))
            .getByText("@QueuedJeep")
            .closest("[data-mention-kind]"),
        ).toHaveAttribute("data-mention-kind", "file");
      });
      await waitFor(() => {
        expect(renderComposerPdfPreview).toHaveBeenCalledWith({
          path: "/Users/huntharo/Downloads/Jeep",
        });
      });

      fireEvent.click(
        within(screen.getByLabelText("Pending steer message")).getByRole("button", {
          name: "Edit",
        }),
      );

      await waitFor(() => {
        expect(
          within(screen.getByTestId("composer-tiptap-input"))
            .getByText("@SteerJeep")
            .closest("[data-mention-kind]"),
        ).toHaveAttribute("data-mention-kind", "file");
      });
      await waitFor(() => {
        expect(renderComposerPdfPreview).toHaveBeenLastCalledWith({
          knownFileIdentity: "queued-pdf-v1",
          path: "/Users/huntharo/Downloads/Jeep",
        });
      });
      expect(inspectPdfReferencePaths).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
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

  it("submits one steer when multiple injection opportunities arrive together", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const steerDeferred = createDeferred<{
      backend: "codex";
      threadId: string;
      turnId: string;
    }>();
    const steerTurn = vi.fn(() => steerDeferred.promise);

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
          title: "Steer collision",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Change direction once" },
    });
    fireEvent.keyDown(screen.getByLabelText("Reply"), {
      key: "Enter",
      metaKey: true,
    });

    expect(screen.getByText("Steering now")).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: { type: "commandExecution" },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "exec_command/ended",
          params: { threadId: "thread-1" },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            item: { type: "commandExecution" },
          },
        },
      });
    });

    expect(steerTurn).toHaveBeenCalledTimes(1);

    await act(async () => {
      steerDeferred.resolve({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
      });
      await steerDeferred.promise;
    });
  });

  it("projects the backend-owned fallback when a steer target is no longer active", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const steerTurn = vi.fn(async (request: SteerTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: request.expectedTurnId,
      disposition: "scheduled" as const,
      scheduledAction: {
        id: "scheduled-fallback-1",
        backend: request.backend,
        threadId: request.threadId,
        kind: "turn" as const,
        origin: "desktop" as const,
        status: "queued" as const,
        scheduledFor: Date.now(),
        displayText: request.fallback?.displayText ?? "",
        turn: request.fallback?.turn,
        queueEntryId: "scheduled-turn:scheduled-fallback-1",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-2",
    }));
    const onActiveTurnIdChange = vi.fn();

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
        onActiveTurnIdChange={onActiveTurnIdChange}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Recovered stale steer",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Send after stale steer" },
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
              output: "ready",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(steerTurn).toHaveBeenCalledTimes(1);
      expect(steerTurn).toHaveBeenCalledWith(expect.objectContaining({
        expectedTurnId: "turn-1",
        fallback: expect.objectContaining({
          displayText: "Send after stale steer",
          turn: expect.objectContaining({
            input: [{ type: "text", text: "Send after stale steer" }],
          }),
        }),
      }));
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(screen.queryByText("Pending steer")).not.toBeInTheDocument();
    expect(screen.getByText("Queued next")).toBeInTheDocument();
  });

  it("does not reinterpret a backend-owned stale steer fallback in React", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const steerTurn = vi.fn(async (request: SteerTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: request.expectedTurnId,
      disposition: "scheduled" as const,
      scheduledAction: {
        id: "scheduled-fallback-2",
        backend: request.backend,
        threadId: request.threadId,
        kind: "turn" as const,
        origin: "desktop" as const,
        status: "queued" as const,
        scheduledFor: Date.now(),
        displayText: request.fallback?.displayText ?? "",
        turn: request.fallback?.turn,
        queueEntryId: "scheduled-turn:scheduled-fallback-2",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    }));
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-3",
    }));
    const onActiveTurnIdChange = vi.fn();

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
        onActiveTurnIdChange={onActiveTurnIdChange}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Queued stale steer",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Queue after the real active turn" },
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
              output: "ready",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(steerTurn).toHaveBeenCalledTimes(1);
    });
    expect(startTurn).not.toHaveBeenCalled();
    expect(screen.getByText("Queued next")).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-2",
            turn: {
              id: "turn-2",
              status: "completed",
            },
          },
        },
      });
    });

    expect(startTurn).not.toHaveBeenCalled();
  });

  it("does not restore a handed-off steer when turn completion leaves a backend queue", async () => {
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
      turnId: "queue-entry-1",
      queueStatus: "queued" as const,
      queueEntryId: "queue-entry-1",
    }));
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
    expect(screen.getByText("Steering now")).toBeInTheDocument();
    expect(steerTurn).toHaveBeenCalledTimes(1);

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

    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(textarea).toHaveValue("");
    expect(screen.queryByText("Pending steer")).not.toBeInTheDocument();
    expect(screen.getByText("Queued follow-up")).toBeInTheDocument();
  });

  it("does not redispatch after a backend queue projection is cleared elsewhere", async () => {
    const draftStore = createComposerDraftStore();
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-2",
    }));
    const thread = {
      id: "thread-1",
      title: "Claimed queue",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const props = {
      backends: [backendSummary("codex")],
      desktopApi: {
        onAgentEvent: () => () => undefined,
        startTurn,
      },
      disabled: false,
      draftStore,
      skills: [],
      thread,
    };
    const { rerender } = render(
      <Composer
        {...props}
        activeTurnId="turn-1"
      />,
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Queued elsewhere" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(screen.getByText("Queued next")).toBeInTheDocument();

    const scopeKey = "thread:codex:thread-1";
    const queued = draftStore.getQueuedTurn(scopeKey);
    expect(queued?.text).toBe("Queued elsewhere");
    draftStore.removeQueuedTurnById(scopeKey, queued!.id);

    rerender(
      <Composer
        {...props}
        activeTurnId={undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Queued elsewhere")).not.toBeInTheDocument();
    });
    expect(startTurn).toHaveBeenCalledTimes(1);
  });

  it("releases a due scheduled queued turn ahead of an earlier future scheduled turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00Z"));
    const draftStore = createComposerDraftStore();
    const scopeKey = "thread:codex:thread-1";
    draftStore.setQueuedTurns(scopeKey, [
      {
        id: "queued-later",
        text: "Later scheduled turn",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "Later scheduled turn" }],
        scheduledSendAt: Date.now() + 2 * 60 * 60_000,
      },
      {
        id: "queued-sooner",
        text: "Sooner scheduled turn",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "Sooner scheduled turn" }],
        scheduledSendAt: Date.now() + 15 * 60_000,
      },
    ]);
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-sooner",
    }));
    const thread = {
      id: "thread-1",
      title: "Out of order schedule",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    vi.setSystemTime(new Date("2026-07-10T12:15:00Z"));
    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        draftStore={draftStore}
        skills={[]}
        thread={thread}
      />
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(startTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ type: "text", text: "Sooner scheduled turn" }],
      })
    );
    expect(draftStore.getQueuedTurns(scopeKey).map((entry) => entry.text)).toEqual([
      "Later scheduled turn",
    ]);
  });

  it("dispatches a queued turn even when selected-thread preflight would block a new send", async () => {
    const draftStore = createComposerDraftStore();
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-2",
    }));
    const onBeforeStartTurn = vi.fn(async () => false);
    const thread = {
      id: "thread-1",
      title: "Blocked queue",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const props = {
      backends: [backendSummary("codex")],
      desktopApi: {
        onAgentEvent: () => () => undefined,
        startTurn,
      },
      disabled: false,
      draftStore,
      onBeforeStartTurn,
      skills: [],
      thread,
    };
    const { rerender } = render(
      <Composer
        {...props}
        activeTurnId="turn-1"
      />,
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "Queued preflight block" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(screen.getByText("Queued next")).toBeInTheDocument();

    rerender(
      <Composer
        {...props}
        activeTurnId={undefined}
      />,
    );

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-1",
          input: [{ type: "text", text: "Queued preflight block" }],
        })
      );
    });
    await waitFor(() => {
      expect(screen.queryByText("Queued preflight block")).not.toBeInTheDocument();
    });
    expect(
      draftStore.getQueuedTurn("thread:codex:thread-1"),
    ).toBeUndefined();
    expect(onBeforeStartTurn).not.toHaveBeenCalled();
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

    expect(screen.getByLabelText("Fast mode")).toBeInTheDocument();

    chooseDropdownOption("Model", "GPT-5.2");

    await waitFor(() => {
      expect(onSetThreadModelSettings).toHaveBeenCalledWith({
        model: "gpt-5.2",
        fastMode: undefined,
      });
    });
  });

  it("hides Fast controls when the profile prohibits Codex Fast mode", () => {
    render(
      <Composer
        backends={[
          backendSummary("codex", {
            models: [
              {
                id: "gpt-5.6-sol",
                label: "GPT-5.6-Sol",
                current: true,
                supportsFast: true,
              },
            ],
            supportsFastMode: true,
          }),
        ]}
        codexFastAllowed={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Fast prohibited",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          model: "gpt-5.6-sol",
          fastMode: true,
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />,
    );

    expect(screen.queryByLabelText("Fast mode")).not.toBeInTheDocument();
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
    await clickButton("Send");

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

  it("requires a project choice before reviewing a thread with multiple worktrees", async () => {
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
          linkedDirectories: [
            {
              id: "/Users/huntharo/GIPHY/giphy-services",
              kind: "worktree",
              label: "giphy-services",
              path: "/Users/huntharo/GIPHY/giphy-services",
              worktreePath:
                "/Users/huntharo/.codex/profiles/sstk/worktrees/mr9mnf9z/giphy-services",
            },
            {
              id: "/Users/huntharo/GIPHY/gif-recommendations",
              kind: "worktree",
              label: "gif-recommendations",
              path: "/Users/huntharo/GIPHY/gif-recommendations",
              worktreePath:
                "/Users/huntharo/.codex/profiles/sstk/worktrees/mr9motar/gif-recommendations",
            },
          ],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review main" },
    });
    await clickButton("Send");

    expect(startReview).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Review project")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start review" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Review project"), {
      target: {
        value:
          "/Users/huntharo/.codex/profiles/sstk/worktrees/mr9motar/gif-recommendations",
      },
    });
    await clickButton("Start review");

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
        cwd: "/Users/huntharo/.codex/profiles/sstk/worktrees/mr9motar/gif-recommendations",
      });
    });
  });

  it("defaults a multi-project review to the changed primary workspace", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const appDirectory: NavigationDirectorySummary = {
      key: "directory:app",
      kind: "directory",
      label: "App",
      path: "/repo/app",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      gitStatus: {
        currentBranch: "feature/app",
        defaultBranch: "main",
        branches: ["feature/app", "main", "release"],
        baseBranches: ["release", "main"],
      },
    };
    const infraDirectory: NavigationDirectorySummary = {
      key: "directory:infra",
      kind: "directory",
      label: "Infra",
      path: "/repo/infra",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      gitStatus: {
        currentBranch: "feature/infra",
        defaultBranch: "develop",
        branches: ["feature/infra", "develop"],
        baseBranches: ["develop"],
      },
    };

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
        }}
        directory={infraDirectory}
        directories={[infraDirectory, appDirectory]}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Review thread",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          projectKey: "/worktrees/app/packages/service",
          gitWorkingState: {
            dirtyFiles: 0,
            dirtyAdditions: 0,
            dirtyDeletions: 0,
            untrackedFiles: 0,
            unpushedCommits: 0,
            baseBranch: "release",
            baseAheadCommitCount: 1,
          },
          linkedDirectories: [
            {
              id: "directory:infra",
              kind: "worktree",
              label: "Infra",
              path: "/repo/infra",
              worktreePath: "/worktrees/infra",
            },
            {
              id: "directory:app",
              kind: "worktree",
              label: "App",
              path: "/repo/app",
              worktreePath: "/worktrees/app",
            },
          ],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(screen.getByLabelText("Review project")).toHaveValue("/worktrees/app");
    await waitFor(() => {
      expect(screen.getByLabelText("Base branch")).toHaveValue("release");
    });
    expect(screen.getByRole("button", { name: "Start review" })).toBeEnabled();

    await clickButton("Start review");

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "release" },
        delivery: "inline",
        cwd: "/worktrees/app",
      });
    });
  });

  it("reloads review base branches when the review project changes", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const giphyDirectory: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/GIPHY/giphy-services",
      kind: "directory",
      label: "giphy-services",
      path: "/Users/huntharo/GIPHY/giphy-services",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      gitStatus: {
        currentBranch: "fix-channels-tagged-magic-tags-table",
        defaultBranch: "main",
        branches: ["fix-channels-tagged-magic-tags-table", "main"],
        baseBranches: [
          "origin/main",
          "main",
          "fix-channels-tagged-magic-tags-table",
        ],
        syncState: "untracked",
      },
    };
    const kubeDirectory: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/infra/kube-manifests",
      kind: "directory",
      label: "kube-manifests",
      path: "/Users/huntharo/infra/kube-manifests",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      gitStatus: {
        currentBranch: "deploy/search-grpc",
        defaultBranch: "develop",
        branches: ["deploy/search-grpc", "develop"],
        baseBranches: [
          "origin/develop",
          "develop",
          "deploy/search-grpc",
        ],
        syncState: "untracked",
      },
    };

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
        }}
        directory={giphyDirectory}
        directories={[giphyDirectory, kubeDirectory]}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Search gRPC",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "deploy/search-grpc",
          executionMode: "default",
          linkedDirectories: [
            {
              id: "/Users/huntharo/GIPHY/giphy-services",
              kind: "worktree",
              label: "giphy-services",
              path: "/Users/huntharo/GIPHY/giphy-services",
              worktreePath:
                "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/giphy-services",
            },
            {
              id: "/Users/huntharo/infra/kube-manifests",
              kind: "worktree",
              label: "kube-manifests",
              path: "/Users/huntharo/infra/kube-manifests",
              worktreePath:
                "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/kube-manifests",
            },
          ],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(screen.getByLabelText("Base branch")).toHaveValue("origin/main");

    fireEvent.change(screen.getByLabelText("Review project"), {
      target: {
        value:
          "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/kube-manifests",
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Base branch")).toHaveValue("origin/develop");
    });

    fireEvent.click(screen.getByLabelText("Base branch"));
    expect(
      screen.getByRole("option", { name: "origin/develop" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "origin/main" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "origin/develop" },
        delivery: "inline",
        cwd:
          "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/kube-manifests",
      });
    });
  });

  it("reloads review commit suggestions when the review project changes", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const giphyCommit = {
      sha: "1111111111111111111111111111111111111111",
      shortSha: "1111111",
      committedAt: 1_700_000_000,
      subject: "Update giphy service",
    };
    const kubeCommit = {
      sha: "2222222222222222222222222222222222222222",
      shortSha: "2222222",
      committedAt: 1_700_000_500,
      subject: "Update kube manifest",
    };
    const giphyDirectory: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/GIPHY/giphy-services",
      kind: "directory",
      label: "giphy-services",
      path: "/Users/huntharo/GIPHY/giphy-services",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      gitStatus: {
        currentBranch: "fix-channels-tagged-magic-tags-table",
        defaultBranch: "main",
        branches: ["fix-channels-tagged-magic-tags-table", "main"],
        recentCommits: [giphyCommit],
        syncState: "untracked",
      },
    };
    const kubeDirectory: NavigationDirectorySummary = {
      key: "directory:/Users/huntharo/infra/kube-manifests",
      kind: "directory",
      label: "kube-manifests",
      path: "/Users/huntharo/infra/kube-manifests",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      gitStatus: {
        currentBranch: "deploy/search-grpc",
        defaultBranch: "develop",
        branches: ["deploy/search-grpc", "develop"],
        recentCommits: [kubeCommit],
        syncState: "untracked",
      },
    };

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
        }}
        directory={giphyDirectory}
        directories={[giphyDirectory, kubeDirectory]}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Search gRPC",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "deploy/search-grpc",
          executionMode: "default",
          linkedDirectories: [
            {
              id: "/Users/huntharo/GIPHY/giphy-services",
              kind: "worktree",
              label: "giphy-services",
              path: "/Users/huntharo/GIPHY/giphy-services",
              worktreePath:
                "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/giphy-services",
            },
            {
              id: "/Users/huntharo/infra/kube-manifests",
              kind: "worktree",
              label: "kube-manifests",
              path: "/Users/huntharo/infra/kube-manifests",
              worktreePath:
                "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/kube-manifests",
            },
          ],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");
    fireEvent.change(screen.getByLabelText("Review project"), {
      target: {
        value:
          "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/kube-manifests",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: /Review one commit by SHA/i }));

    const commitInput = await screen.findByRole("combobox", {
      name: "Commit SHA",
    });
    await waitFor(() => {
      expect(screen.getByRole("option", { name: /2222222 Update kube manifest/i }))
        .toBeInTheDocument();
    });
    expect(
      screen.queryByRole("option", { name: /1111111 Update giphy service/i }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: /2222222 Update kube manifest/i }));
    expect(commitInput).toHaveValue(kubeCommit.sha);
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "commit", sha: kubeCommit.sha, title: null },
        delivery: "inline",
        cwd:
          "/Users/huntharo/.codex/profiles/sstk/worktrees/mrctwp7f/kube-manifests",
      });
    });
  });

  it("starts slash reviews with the current composer model settings", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));

    render(
      <Composer
        backends={[
          {
            ...backendSummary("codex", {
              models: [
                {
                  id: "gpt-5.5",
                  label: "GPT-5.5",
                  current: true,
                  supportsFast: true,
                  supportsReasoning: true,
                },
              ],
              reasoningEfforts: ["medium", "high"],
            }),
            capabilities: {
              ...backendSummary("codex").capabilities,
              startReview: true,
            },
          },
        ]}
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
          model: "gpt-5.5",
          reasoningEffort: "high",
          serviceTier: "priority",
          fastMode: true,
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review main" },
    });
    await clickButton("Send");

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
        model: "gpt-5.5",
        reasoningEffort: "high",
        serviceTier: "priority",
        fastMode: true,
      });
    });
  });

  it("ignores a duplicate slash review submit while the review start is pending", async () => {
    const startTurn = vi.fn();
    const addOptimisticReviewEntry = vi.fn(() => "review-optimistic-1");
    const startReviewDeferred = createDeferred<{
      backend: "codex";
      threadId: string;
      reviewThreadId: string;
      turnId: string;
    }>();
    const startReview = vi.fn(() => startReviewDeferred.promise);

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

    const textarea = screen.getByLabelText("Reply");
    const form = textarea.closest("form");
    expect(form).not.toBeNull();

    fireEvent.change(textarea, {
      target: { value: "/review main" },
    });

    await act(async () => {
      fireEvent.submit(form!);
      fireEvent.submit(form!);
      await Promise.resolve();
    });

    expect(startReview).toHaveBeenCalledTimes(1);
    expect(addOptimisticReviewEntry).toHaveBeenCalledTimes(1);
    expect(startTurn).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("");
    expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();

    await act(async () => {
      startReviewDeferred.resolve({
        backend: "codex",
        threadId: "thread-1",
        reviewThreadId: "thread-1",
        turnId: "turn-review-1",
      });
    });
  });

  it("preserves newer reply edits when starting a review fails after clearing", async () => {
    const startReviewDeferred = createDeferred<{
      backend: "codex";
      threadId: string;
      reviewThreadId: string;
      turnId: string;
    }>();
    const startReview = vi.fn(() => startReviewDeferred.promise);

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
          startTurn: vi.fn(),
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
    fireEvent.change(textarea, {
      target: { value: "/review main" },
    });
    await clickButton("Send");
    expect(textarea).toHaveValue("");

    fireEvent.change(textarea, { target: { value: "Next draft" } });
    await act(async () => {
      startReviewDeferred.reject(new Error("Review failed"));
    });

    await waitFor(() => {
      expect(textarea).toHaveValue("Next draft");
      expect(screen.getByText("Review failed")).toBeInTheDocument();
    });
  });

  it("queues an identical slash review after the previous review start is accepted", async () => {
    const startTurn = vi.fn();
    const addOptimisticReviewEntry = vi.fn(() => "review-optimistic-1");
    const startReviewDeferred = createDeferred<{
      backend: "codex";
      threadId: string;
      reviewThreadId: string;
      turnId: string;
    }>();
    const startReview = vi.fn(() => startReviewDeferred.promise);
    const scheduledApi = createScheduledActionApi();

    render(
      <Composer
        addOptimisticReviewEntry={addOptimisticReviewEntry}
        desktopApi={{
          ...scheduledApi,
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

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, {
      target: { value: "/review main" },
    });
    await clickButton("Send");

    await act(async () => {
      startReviewDeferred.resolve({
        backend: "codex",
        threadId: "thread-1",
        reviewThreadId: "thread-1",
        turnId: "turn-review-1",
      });
    });

    fireEvent.change(textarea, {
      target: { value: "/review main" },
    });
    await clickButton("Queue");

    expect(startReview).toHaveBeenCalledTimes(1);
    expect(scheduledApi.createScheduledThreadAction).toHaveBeenCalledTimes(1);
    expect(addOptimisticReviewEntry).toHaveBeenCalledTimes(1);
    expect(startTurn).not.toHaveBeenCalled();
    expect(screen.getByText("Queued next")).toBeInTheDocument();
    expect(screen.getByText("Review changes against main")).toBeInTheDocument();
  });

  it("keeps review completion tied to the review/start turn id", async () => {
    let agentEventHandler: ((event: {
      backend: "codex";
      notification: {
        method: string;
        params: Record<string, unknown>;
      };
    }) => void) | undefined;
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-response",
    }));

    render(
      <Composer
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startReview,
          startTurn: vi.fn(),
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
    await clickButton("Send");

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-started-notification",
              status: "inProgress",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: { type: "idle" },
          },
        },
      });
    });
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review-response",
            turn: {
              id: "turn-review-response",
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

  it("does not open the review picker for backends without review support", async () => {
    const kimiBackend = backendSummary("acp:kimi" as BackendSummary["kind"]);
    const startReview = vi.fn();
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "turn-1",
    }));

    render(
      <Composer
        backends={[
          {
            ...kimiBackend,
            capabilities: {
              ...kimiBackend.capabilities,
              startReview: false,
            },
          },
        ]}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
          startTurn,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "kimi-session-1",
          title: "Kimi thread",
          titleSource: "explicit",
          source: "acp:kimi",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument();
    expect(startReview).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "acp:kimi",
          threadId: "kimi-session-1",
          input: [{ type: "text", text: "/review" }],
        }),
      );
    });
  });

  it("queues review target submissions while a turn is active", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const scheduledApi = createScheduledActionApi();
    const baseProps = {
      desktopApi: {
        ...scheduledApi,
        onAgentEvent: () => () => undefined,
        startReview,
      },
      backends: [
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
      ],
      disabled: false,
      skills: [],
      thread: {
        id: "thread-1",
        title: "Review thread",
        titleSource: "explicit" as const,
        source: "codex" as const,
        executionMode: "default" as const,
        linkedDirectories: [],
        inbox: { inInbox: false },
      },
    };

    const { rerender } = render(<Composer {...baseProps} />);

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "/review" } });
    await clickButton("Send");
    expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();

    rerender(<Composer {...baseProps} activeTurnId="turn-1" />);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Compare this branch with a base branch/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    expect(startReview).not.toHaveBeenCalled();
    expect(await screen.findByText("Queued next")).toBeInTheDocument();
    expect(screen.getByText("Review changes against main")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Steer" })).not.toBeInTheDocument();

    rerender(<Composer {...baseProps} activeTurnId={undefined} />);

    expect(startReview).not.toHaveBeenCalled();
    expect(scheduledApi.createScheduledThreadAction).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "codex",
        threadId: "thread-1",
        kind: "review",
      }),
    );
  });

  it("keeps the review target picker for bare review commands during an active turn", async () => {
    const startReview = vi.fn();

    render(
      <Composer
        activeTurnId="turn-1"
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
    await clickButton("Queue");

    expect(startReview).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();
    expect(screen.queryByText("Queued next")).not.toBeInTheDocument();
  });

  it("starts a queued review without clearing the next live draft", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const imageFile = new File([new Uint8Array([1, 2, 3])], "next-draft.png", {
      type: "image/png",
    });
    const scheduledApi = createScheduledActionApi();
    const baseProps = {
      desktopApi: {
        ...scheduledApi,
        onAgentEvent: () => () => undefined,
        startReview,
      },
      disabled: false,
      skills: [],
      thread: {
        id: "thread-1",
        title: "Review thread",
        titleSource: "explicit" as const,
        source: "codex" as const,
        executionMode: "default" as const,
        linkedDirectories: [],
        inbox: { inInbox: false },
      },
    };

    const { rerender } = render(<Composer {...baseProps} activeTurnId="turn-1" />);

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review main" },
    });
    await clickButton("Queue");
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

    expect(await screen.findByAltText("next-draft.png")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "keep this next draft" },
    });

    rerender(<Composer {...baseProps} activeTurnId={undefined} />);

    expect(startReview).not.toHaveBeenCalled();
    expect(scheduledApi.createScheduledThreadAction).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "review" }),
    );
    expect(
      screen.queryByText("/review does not accept image attachments.")
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toHaveValue("keep this next draft");
    expect(screen.getByAltText("next-draft.png")).toBeInTheDocument();
  });

  it("rejects review queue attempts with live image attachments", async () => {
    const startReview = vi.fn();
    const imageFile = new File([new Uint8Array([1, 2, 3])], "review-image.png", {
      type: "image/png",
    });

    render(
      <Composer
        activeTurnId="turn-1"
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
    expect(await screen.findByAltText("review-image.png")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review main" },
    });
    await clickButton("Queue");

    expect(startReview).not.toHaveBeenCalled();
    expect(screen.queryByText("Queued next")).not.toBeInTheDocument();
    expect(screen.getByText("/review does not accept image attachments.")).toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toHaveValue("/review main");
    expect(screen.getByAltText("review-image.png")).toBeInTheDocument();
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
    expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
    const baseBranchTarget = screen.getByRole("button", {
      name: /Compare this branch with a base branch/i,
    });
    expect(baseBranchTarget).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(baseBranchTarget).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("button", { name: /Current changes/i })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByRole("button", { name: /Review one commit by SHA/i })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByRole("button", { name: /Review using custom instructions/i })).toHaveAttribute(
      "tabindex",
      "-1",
    );
    expect(screen.getByLabelText("Base branch")).not.toHaveAttribute(
      "tabindex",
      "-1",
    );
    await waitFor(() => {
      expect(baseBranchTarget).toHaveFocus();
    });
    expect(screen.getByLabelText("Base branch")).toHaveValue("main");
    expect(startReview).not.toHaveBeenCalled();

    fireEvent.keyDown(baseBranchTarget, {
      key: "Enter",
    });

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
        delivery: "inline",
      });
    });
  });

  it("moves review target focus with arrow keys and submits the focused target with Enter", async () => {
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
    await clickButton("Send");
    const baseBranchTarget = screen.getByRole("button", {
      name: /Compare this branch with a base branch/i,
    });
    await waitFor(() => {
      expect(baseBranchTarget).toHaveFocus();
    });

    fireEvent.keyDown(baseBranchTarget, {
      key: "ArrowRight",
    });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Current changes/i })).toHaveFocus();
    });
    expect(screen.getByRole("button", { name: /Current changes/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(baseBranchTarget).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("button", { name: /Current changes/i })).toHaveAttribute(
      "tabindex",
      "0",
    );

    fireEvent.keyDown(screen.getByRole("button", { name: /Current changes/i }), {
      key: "Enter",
    });

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "uncommittedChanges" },
        delivery: "inline",
      });
    });
  });

  it("submits the focused review target when keyboard focus moves without changing selection", async () => {
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
    await clickButton("Send");

    const currentChangesTarget = screen.getByRole("button", {
      name: /Current changes/i,
    });
    currentChangesTarget.focus();
    expect(currentChangesTarget).toHaveFocus();
    expect(currentChangesTarget).toHaveAttribute("aria-pressed", "false");

    fireEvent.keyDown(currentChangesTarget, {
      key: "Enter",
    });

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "uncommittedChanges" },
        delivery: "inline",
      });
    });
  });

  it("cancels the bare review target prompt with Escape from cards and fields", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));

    const { rerender } = render(
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
    await clickButton("Send");
    fireEvent.keyDown(
      screen.getByRole("button", {
        name: /Compare this branch with a base branch/i,
      }),
      { key: "Escape" },
    );
    expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText("Reply")).toHaveFocus();
    });

    rerender(
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
    await clickButton("Send");
    fireEvent.click(screen.getByRole("button", { name: /Review one commit by SHA/i }));
    const commitInput = await screen.findByRole("combobox", {
      name: "Commit SHA",
    });
    await waitFor(() => {
      expect(commitInput).toHaveFocus();
    });
    fireEvent.keyDown(commitInput, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument();
  });

  it("uses the branch picker to override the selected base branch", async () => {
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
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "feature/review",
            defaultBranch: "main",
            branches: ["feature/review", "release", "main"],
            baseBranches: ["main", "release"],
            syncState: "untracked",
          },
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
    await clickButton("Send");

    expect(screen.getByLabelText("Base branch")).toHaveValue("main");
    fireEvent.click(screen.getByLabelText("Base branch"));
    fireEvent.click(screen.getByRole("option", { name: "release" }));

    const reviewTarget = screen.getByRole("group", { name: "Review target" });
    const form = reviewTarget.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "release" },
        delivery: "inline",
      });
    });
  });

  it("filters review base branch options without replacing the selected branch text", async () => {
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview: vi.fn(),
        }}
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "feature/review",
            defaultBranch: "main",
            branches: ["feature/review", "release", "main"],
            baseBranches: ["main", "release", "hotfix"],
            syncState: "untracked",
          },
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
    await clickButton("Send");

    const baseBranchInput = screen.getByLabelText("Base branch");
    expect(baseBranchInput).toHaveValue("main");
    fireEvent.click(baseBranchInput);
    fireEvent.change(screen.getByLabelText("Find a branch"), {
      target: { value: "rel" },
    });

    expect(baseBranchInput).toHaveValue("main");
    expect(screen.getByRole("option", { name: "release" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "hotfix" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "release" }));
    expect(baseBranchInput).toHaveValue("release");
  });

  it("closes an empty review branch filter menu with Escape", async () => {
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview: vi.fn(),
        }}
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "feature/review",
            defaultBranch: "main",
            branches: ["feature/review", "release", "main"],
            baseBranches: ["main", "release", "hotfix"],
            syncState: "untracked",
          },
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
    await clickButton("Send");

    fireEvent.click(screen.getByLabelText("Base branch"));
    const filterInput = screen.getByLabelText("Find a branch");
    fireEvent.change(filterInput, { target: { value: "no-such-branch" } });

    expect(screen.getByText("No branches match your filter.")).toBeInTheDocument();

    fireEvent.keyDown(filterInput, { key: "Escape" });

    expect(
      screen.queryByText("No branches match your filter."),
    ).not.toBeInTheDocument();
  });

  it("accepts a custom review base ref that is not in the branch picker options", async () => {
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
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "feature/review",
            defaultBranch: "main",
            branches: ["feature/review", "main"],
            baseBranches: ["main"],
            syncState: "untracked",
          },
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
    await clickButton("Send");

    const baseBranchInput = screen.getByLabelText("Base branch");
    fireEvent.change(baseBranchInput, {
      target: { value: "origin/releases/2026.07" },
    });
    expect(baseBranchInput).toHaveValue("origin/releases/2026.07");
    expect(
      screen.queryByRole("option", { name: "origin/releases/2026.07" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "origin/releases/2026.07" },
        delivery: "inline",
      });
    });
  });

  it("prefers origin main over unrelated recent local branches for review base", async () => {
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
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "fix/review-base-default-submit",
            defaultBranch: "fix/review-base-default-submit",
            branches: [
              "fix/desktop-terminal-replay-responses",
              "fix/review-base-default-submit",
              "main",
            ],
            baseBranches: [
              "fix/desktop-terminal-replay-responses",
              "fix/review-base-default-submit",
              "origin/fix/review-base-default-submit",
              "origin/main",
              "main",
            ],
            syncState: "untracked",
          },
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Review thread",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "fix/review-base-default-submit",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(screen.getByLabelText("Base branch")).toHaveValue("origin/main");
  });

  it("falls back to main before unrelated directory branches for review base", async () => {
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
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "fix/pr-chip-tooltip-dismiss",
            defaultBranch: "fix/pr-chip-tooltip-dismiss",
            branches: ["fix/pr-chip-tooltip-dismiss"],
            baseBranches: ["fix/pr-chip-tooltip-dismiss"],
            syncState: "untracked",
          },
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Msg - Control response scope",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "feat/messaging-response-mode",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(screen.getByLabelText("Base branch")).toHaveValue("main");
  });

  it("keeps an unrelated directory upstream behind safe review bases", async () => {
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview: vi.fn(),
        }}
        directory={{
          key: "directory:/Users/huntharo/GIPHY/giphy-services",
          kind: "directory",
          label: "giphy-services",
          path: "/Users/huntharo/GIPHY/giphy-services",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "search-gha-deploy-cutover",
            defaultBranch: "search-gha-deploy-cutover",
            upstreamBranch: "origin/search-gha-deploy-cutover",
            branches: [
              "search-gha-deploy-cutover",
              "main",
            ],
            baseBranches: [
              "search-gha-deploy-cutover",
              "origin/search-gha-deploy-cutover",
              "origin/main",
              "main",
            ],
            syncState: "untracked",
          },
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "channelsv2",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "fix-channels-tagged-magic-tags-table",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(screen.getByLabelText("Base branch")).toHaveValue("origin/main");
  });

  it("prefers the thread git-derived worktree base branch over main for reviews", async () => {
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
          title: "channelsv2",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "channelsv2-get-tagged-channels-by-asset-id",
          gitWorkingState: {
            dirtyFiles: 0,
            dirtyAdditions: 0,
            dirtyDeletions: 0,
            untrackedFiles: 0,
            unpushedCommits: 1,
            baseBranch: "origin/develop",
          },
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(screen.getByLabelText("Base branch")).toHaveValue("origin/develop");

    const reviewTarget = screen.getByRole("group", { name: "Review target" });
    const form = reviewTarget.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "origin/develop" },
        delivery: "inline",
      });
    });
  });

  it("resolves a remote-agnostic git-derived review base to a known remote ref", async () => {
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
        directory={{
          key: "directory:/Users/huntharo/GIPHY/giphy-services",
          kind: "directory",
          label: "giphy-services",
          path: "/Users/huntharo/GIPHY/giphy-services",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "channelsv2-get-tagged-channels-by-asset-id",
            defaultBranch: "develop",
            branches: [
              "channelsv2-get-tagged-channels-by-asset-id",
              "main",
            ],
            baseBranches: [
              "channelsv2-get-tagged-channels-by-asset-id",
              "origin/main",
              "origin/develop",
            ],
            syncState: "untracked",
          },
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "channelsv2",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "channelsv2-get-tagged-channels-by-asset-id",
          gitWorkingState: {
            dirtyFiles: 0,
            dirtyAdditions: 0,
            dirtyDeletions: 0,
            untrackedFiles: 0,
            unpushedCommits: 1,
            baseBranch: "develop",
          },
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(screen.getByLabelText("Base branch")).toHaveValue("origin/develop");

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "origin/develop" },
        delivery: "inline",
      });
    });
  });

  it("does not exclude the default review base just because the local directory is on it", async () => {
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview: vi.fn(),
        }}
        directory={{
          key: "directory:/Users/huntharo/GIPHY/giphy-services",
          kind: "directory",
          label: "giphy-services",
          path: "/Users/huntharo/GIPHY/giphy-services",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "develop",
            defaultBranch: "develop",
            branches: [
              "develop",
              "fix-channels-tagged-magic-tags-table",
            ],
            baseBranches: [
              "develop",
              "origin/develop",
              "origin/master",
            ],
            syncState: "in-sync",
          },
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "channelsv2",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "fix-channels-tagged-magic-tags-table",
          executionMode: "default",
          linkedDirectories: [
            {
              id: "/Users/huntharo/.codex/profiles/sstk/worktrees/mr3qwmcx/giphy-services",
              kind: "worktree",
              label: "giphy-services",
              path: "/Users/huntharo/GIPHY/giphy-services",
              worktreePath:
                "/Users/huntharo/.codex/profiles/sstk/worktrees/mr3qwmcx/giphy-services",
            },
          ],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(screen.getByLabelText("Base branch")).toHaveValue("origin/develop");
  });

  it("updates an auto-selected review base when directory branch metadata hydrates", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const desktopApi = {
      onAgentEvent: () => () => undefined,
      startReview,
    };
    const thread = {
      id: "thread-1",
      title: "channelsv2",
      titleSource: "explicit" as const,
      source: "codex" as const,
      gitBranch: "fix-channels-tagged-magic-tags-table",
      executionMode: "default" as const,
      linkedDirectories: [
        {
          id: "/Users/huntharo/.codex/profiles/sstk/worktrees/mr3qwmcx/giphy-services",
          kind: "worktree" as const,
          label: "giphy-services",
          path: "/Users/huntharo/GIPHY/giphy-services",
          worktreePath:
            "/Users/huntharo/.codex/profiles/sstk/worktrees/mr3qwmcx/giphy-services",
        },
      ],
      inbox: { inInbox: false },
    };
    const hydratedDirectory = {
      key: "directory:/Users/huntharo/GIPHY/giphy-services",
      kind: "directory" as const,
      label: "giphy-services",
      path: "/Users/huntharo/GIPHY/giphy-services",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      gitStatus: {
        currentBranch: "fix-channels-tagged-magic-tags-table",
        defaultBranch: "develop",
        branches: [
          "fix-channels-tagged-magic-tags-table",
          "develop",
        ],
        baseBranches: [
          "fix-channels-tagged-magic-tags-table",
          "origin/fix-channels-tagged-magic-tags-table",
          "develop",
          "origin/develop",
          "origin/master",
        ],
        syncState: "untracked" as const,
      },
    };

    const { rerender } = render(
      <Composer
        desktopApi={desktopApi}
        disabled={false}
        skills={[]}
        thread={thread}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(screen.getByLabelText("Base branch")).toHaveValue("main");

    rerender(
      <Composer
        desktopApi={desktopApi}
        directory={hydratedDirectory}
        disabled={false}
        skills={[]}
        thread={thread}
      />
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Base branch")).toHaveValue("origin/develop");
    });

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "origin/develop" },
        delivery: "inline",
        cwd:
          "/Users/huntharo/.codex/profiles/sstk/worktrees/mr3qwmcx/giphy-services",
      });
    });
  });

  it("keeps a user-entered review base when directory branch metadata hydrates", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const desktopApi = {
      onAgentEvent: () => () => undefined,
      startReview,
    };
    const thread = {
      id: "thread-1",
      title: "channelsv2",
      titleSource: "explicit" as const,
      source: "codex" as const,
      gitBranch: "fix-channels-tagged-magic-tags-table",
      executionMode: "default" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const hydratedDirectory = {
      key: "directory:/Users/huntharo/GIPHY/giphy-services",
      kind: "directory" as const,
      label: "giphy-services",
      path: "/Users/huntharo/GIPHY/giphy-services",
      threadKeys: ["codex:thread-1"],
      needsAttentionCount: 0,
      gitStatus: {
        currentBranch: "fix-channels-tagged-magic-tags-table",
        defaultBranch: "develop",
        branches: ["fix-channels-tagged-magic-tags-table", "develop"],
        baseBranches: ["origin/develop", "develop"],
        syncState: "untracked" as const,
      },
    };

    const { rerender } = render(
      <Composer
        desktopApi={desktopApi}
        disabled={false}
        skills={[]}
        thread={thread}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    const baseBranchInput = screen.getByLabelText("Base branch");
    fireEvent.change(baseBranchInput, {
      target: { value: "origin/release-candidate" },
    });

    rerender(
      <Composer
        desktopApi={desktopApi}
        directory={hydratedDirectory}
        disabled={false}
        skills={[]}
        thread={thread}
      />
    );

    expect(screen.getByLabelText("Base branch")).toHaveValue(
      "origin/release-candidate",
    );
  });

  it("suggests recent commits for commit reviews and caps the list at twenty", async () => {
    const startReview = vi.fn(async (request: StartReviewRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      reviewThreadId: request.threadId,
      turnId: "turn-review-1",
    }));
    const recentCommits = Array.from({ length: 25 }, (_, index) => ({
      sha: `${index.toString(16).padStart(40, "0")}`,
      shortSha: `c${index.toString().padStart(2, "0")}`,
      committedAt: Math.floor(Date.now() / 1000) - index * 60,
      subject: `Commit subject ${index}`,
    }));

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview,
        }}
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "feature/review",
            defaultBranch: "main",
            branches: ["feature/review", "main"],
            recentCommits,
            syncState: "untracked",
          },
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
    await clickButton("Send");
    fireEvent.click(screen.getByRole("button", { name: /Review one commit by SHA/i }));
    const commitInput = await screen.findByRole("combobox", {
      name: "Commit SHA",
    });
    await waitFor(() => {
      expect(commitInput).toHaveFocus();
    });

    expect(screen.getAllByRole("option")).toHaveLength(20);
    expect(screen.getAllByRole("option").map((option) => option.getAttribute("tabindex"))).toEqual(
      Array.from({ length: 20 }, () => "-1"),
    );
    expect(screen.getByRole("option", { name: /c00 Commit subject 0/i })).toHaveClass(
      "is-active",
    );
    fireEvent.keyDown(commitInput, { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /c00 Commit subject 0/i })).not.toHaveClass(
      "is-active",
    );
    expect(screen.getByRole("option", { name: /c01 Commit subject 1/i })).toHaveClass(
      "is-active",
    );
    fireEvent.click(screen.getByRole("option", { name: /c03 Commit subject 3/i }));
    expect(commitInput).toHaveValue(recentCommits[3]!.sha);

    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "commit", sha: recentCommits[3]!.sha, title: null },
        delivery: "inline",
      });
    });
  });

  it("closes commit suggestions with Escape before cancelling the review prompt", async () => {
    const recentCommits = Array.from({ length: 2 }, (_, index) => ({
      sha: `${index.toString(16).padStart(40, "0")}`,
      shortSha: `c${index}`,
      committedAt: Math.floor(Date.now() / 1000) - index * 60,
      subject: `Commit subject ${index}`,
    }));

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startReview: vi.fn(),
        }}
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "feature/review",
            defaultBranch: "main",
            branches: ["feature/review", "main"],
            recentCommits,
            syncState: "untracked",
          },
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
    await clickButton("Send");
    fireEvent.click(screen.getByRole("button", { name: /Review one commit by SHA/i }));
    const commitInput = await screen.findByRole("combobox", {
      name: "Commit SHA",
    });
    await waitFor(() => {
      expect(screen.getByRole("listbox", { name: "Recent commits" })).toBeInTheDocument();
    });

    fireEvent.keyDown(commitInput, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: "Recent commits" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();

    fireEvent.keyDown(commitInput, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument();
  });

  it("still accepts a pasted raw commit SHA", async () => {
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
    await clickButton("Send");
    fireEvent.click(screen.getByRole("button", { name: /Review one commit by SHA/i }));
    const commitInput = await screen.findByRole("combobox", {
      name: "Commit SHA",
    });
    fireEvent.change(commitInput, {
      target: { value: "abc123def456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "commit", sha: "abc123def456", title: null },
        delivery: "inline",
      });
    });
  });

  it("keeps the base branch card selected while preferring remote base refs over the current branch", async () => {
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
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "fix/review-base-default-submit",
            defaultBranch: "fix/review-base-default-submit",
            branches: ["fix/review-base-default-submit"],
            baseBranches: ["fix/review-base-default-submit", "origin/main"],
            syncState: "untracked",
          },
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Review thread",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "fix/review-base-default-submit",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(
      screen.getByRole("button", {
        name: /Compare this branch with a base branch/i,
      }),
    ).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Base branch")).toHaveValue("origin/main");

    const reviewTarget = screen.getByRole("group", { name: "Review target" });
    const form = reviewTarget.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "origin/main" },
        delivery: "inline",
      });
    });
  });

  it("falls back to main when only self branches are reported as review base options", async () => {
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
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "fix/review-base-default-submit",
            defaultBranch: "fix/review-base-default-submit",
            upstreamBranch: "origin/fix/review-base-default-submit",
            branches: ["fix/review-base-default-submit"],
            baseBranches: [
              "fix/review-base-default-submit",
              "origin/fix/review-base-default-submit",
            ],
            syncState: "untracked",
          },
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Review thread",
          titleSource: "explicit",
          source: "codex",
          gitBranch: "fix/review-base-default-submit",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "/review" },
    });
    await clickButton("Send");

    expect(
      screen.getByRole("button", {
        name: /Compare this branch with a base branch/i,
      }),
    ).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByLabelText("Base branch")).toHaveValue("main");

    const reviewTarget = screen.getByRole("group", { name: "Review target" });
    const form = reviewTarget.closest("form");
    expect(form).not.toBeNull();
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(startReview).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        target: { type: "baseBranch", branch: "main" },
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
    await clickButton("Send");
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

  it("opens review composer from slash review autocomplete", async () => {
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

    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
  });

  it("keeps slash review autocomplete open for the exact command text", async () => {
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
    fireEvent.change(textarea, { target: { value: "/revie" } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "/review" } });

    const commands = screen.getByRole("listbox", { name: "Commands" });
    expect(commands).toBeInTheDocument();
    expect(within(commands).getByRole("button", { name: /\/review/i })).toBeInTheDocument();
  });

  it("keeps slash review autocomplete visible while editing the prefix", async () => {
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
    for (const value of ["/", "/r", "/re", "/r"]) {
      fireEvent.change(textarea, { target: { value } });

      const commands = screen.getByRole("listbox", { name: "Commands" });
      expect(commands).toBeInTheDocument();
      expect(within(commands).getByRole("button", { name: /\/review/i })).toBeInTheDocument();
    }
  });

  it("reopens slash autocomplete for a previously dismissed query after editing away", async () => {
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
    fireEvent.change(textarea, { target: { value: "/re" } });
    fireEvent.keyDown(textarea, { key: "Escape", code: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "/r" } });
    expect(screen.getByRole("listbox", { name: "Commands" })).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "/re" } });
    const commands = screen.getByRole("listbox", { name: "Commands" });
    expect(within(commands).getByRole("button", { name: /\/review/i })).toBeInTheDocument();
  });

  it("keeps duplicate local and provider slash commands labeled by source", async () => {
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
        providerCommands={[
          {
            name: "review",
            description: "Run a Codex code review.",
            backend: "codex",
            scope: "backend",
            source: "provider",
          },
        ]}
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

    const commands = screen.getByRole("listbox", { name: "Commands" });
    expect(within(commands).getAllByRole("button", { name: /\/review/i })).toHaveLength(2);
    expect(within(commands).getByText("PwrAgent")).toBeInTheDocument();
    expect(within(commands).getByText("OpenAI")).toBeInTheDocument();
  });

  it("routes Codex compact slash commands to thread compaction", async () => {
    const compactThread = vi.fn(async (request: CompactThreadRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: "compact-turn-1",
    }));
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));

    render(
      <Composer
        desktopApi={{
          compactThread,
          onAgentEvent: () => () => undefined,
          startTurn,
        }}
        disabled={false}
        providerCommands={[
          {
            name: "compact",
            description: "Compact this thread's context.",
            backend: "codex",
            scope: "backend",
            source: "provider",
          },
        ]}
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
    fireEvent.change(textarea, { target: { value: "/compact" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(compactThread).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
      });
    });
    expect(startTurn).not.toHaveBeenCalled();
  });

  it("runs exact compact slash command on Enter even after review was selected", async () => {
    const compactThreadResponse = createDeferred<{
      backend: CompactThreadRequest["backend"];
      threadId: CompactThreadRequest["threadId"];
      turnId: string;
    }>();
    const compactThread = vi.fn((request: CompactThreadRequest) => {
      void request;
      return compactThreadResponse.promise;
    });
    const startReview = vi.fn();

    render(
      <Composer
        desktopApi={{
          compactThread,
          onAgentEvent: () => () => undefined,
          startReview,
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "turn-1",
          }),
        }}
        disabled={false}
        providerCommands={[
          {
            name: "compact",
            description: "Compact this thread's context.",
            backend: "codex",
            scope: "backend",
            source: "provider",
          },
        ]}
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
    expect(
      within(screen.getByRole("listbox", { name: "Commands" })).getByRole(
        "button",
        { name: /\/review/i },
      ),
    ).toHaveAttribute("aria-selected", "true");

    fireEvent.change(textarea, { target: { value: "/co" } });
    const commands = screen.getByRole("listbox", { name: "Commands" });
    expect(within(commands).queryByRole("button", { name: /\/review/i })).not.toBeInTheDocument();
    expect(within(commands).getByRole("button", { name: /\/compact/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.keyDown(textarea, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(compactThread).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
      });
    });
    await waitFor(() => {
      expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
      expect(screen.getByLabelText("Reply")).toHaveValue("");
    });
    expect(startReview).not.toHaveBeenCalled();

    compactThreadResponse.resolve({
      backend: "codex",
      threadId: "thread-1",
      turnId: "compact-turn-1",
    });
  });

  it("inserts provider-native skill commands from slash autocomplete", async () => {
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: async () => ({
            backend: "acp:kimi",
            threadId: "thread-1",
            turnId: "turn-1",
          }),
        }}
        disabled={false}
        providerCommands={[
          {
            name: "skill:frontend-design",
            description: "Load frontend-design",
            aliases: ["fd"],
            backend: "acp:kimi",
            scope: "session",
            source: "provider",
          },
        ]}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Kimi thread",
          titleSource: "explicit",
          source: "acp:kimi",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const textarea = screen.getByLabelText("Reply");
    fireEvent.change(textarea, { target: { value: "/ski" } });

    const commands = screen.getByRole("listbox", { name: "Commands" });
    fireEvent.click(
      within(commands).getByRole("button", { name: /\/skill:frontend-design/i }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Reply")).toHaveValue("/skill:frontend-design ");
    });
  });

  it("opens review composer from the focused slash command option", async () => {
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

    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Reply")).not.toBeInTheDocument();
  });

  it("returns to an empty text entry when review composer is cancelled", async () => {
    render(
      <Composer
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
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("group", { name: "Review target" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toHaveValue("");
    expect(screen.queryByRole("listbox", { name: "Commands" })).not.toBeInTheDocument();
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
        fullAccessRiskWarningDismissed
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
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
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
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
    expect(
      screen.getByRole("radio", { name: /Handoff to Detached HEAD/ })
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByLabelText("Leave current checkout on")).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Handoff to New Branch/ })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Handoff" }));

    await waitFor(() => {
      expect(onHandoffThreadWorkspace).toHaveBeenCalledWith({
        direction: "local-to-worktree",
        strategy: "detached-changes",
        repositoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
        sourcePath: "/Users/huntharo/pwrdrvr/PwrAgent",
        sourceBranch: "feat/thread-workspace-handoff-plan",
      });
    });

    chooseDropdownOption("Access mode", "Full Access");

    await waitFor(() => {
      expect(onSetExecutionMode).toHaveBeenCalledWith("full-access");
    });
  });

  it("shows ACP thread access in the composer", async () => {
    const onSetExecutionMode = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[
          {
            ...backendSummary("acp:kimi"),
            label: "Kimi Code CLI",
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
        disabled={false}
        fullAccessRiskWarningDismissed
        onSetExecutionMode={onSetExecutionMode}
        skills={[]}
        thread={{
          id: "kimi-session-1",
          title: "Kimi thread",
          titleSource: "explicit",
          source: "acp:kimi",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />,
    );

    expect(screen.getByLabelText("Access mode")).toHaveValue("default");

    chooseDropdownOption("Access mode", "Full Access");

    await waitFor(() => {
      expect(onSetExecutionMode).toHaveBeenCalledWith("full-access");
    });
  });

  it("submits a local-to-worktree handoff on a new branch", async () => {
    const onHandoffThreadWorkspace = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[backendSummary("codex")]}
        disabled={false}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "PwrAgent",
          path: "/repo",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "main",
            defaultBranch: "main",
            branches: ["main", "release"],
            handoffBranches: ["release"],
            syncState: "untracked",
          },
        }}
        onHandoffThreadWorkspace={onHandoffThreadWorkspace}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          gitBranch: "main",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/repo",
              kind: "local",
            },
          ],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.click(screen.getByLabelText("Workspace mode"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Handoff to New Worktree" }));
    fireEvent.click(screen.getByRole("radio", { name: /Handoff to New Branch/ }));

    const newBranchInput = screen.getByLabelText("New branch name");
    expect(newBranchInput).toHaveValue("pwragent/main-handoff");
    fireEvent.change(newBranchInput, {
      target: { value: "pwragent/main-wip" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Handoff" }));

    await waitFor(() => {
      expect(onHandoffThreadWorkspace).toHaveBeenCalledWith({
        direction: "local-to-worktree",
        strategy: "new-branch",
        newBranchName: "pwragent/main-wip",
        repositoryPath: "/repo",
        sourcePath: "/repo",
        sourceBranch: "main",
      });
    });
  });

  it("requires confirmation before switching a thread from Default Access to Full Access", async () => {
    const onSetExecutionMode = vi.fn(async () => undefined);
    const onDismissFullAccessRiskWarning = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[
          {
            ...backendSummary("codex"),
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
        disabled={false}
        onDismissFullAccessRiskWarning={onDismissFullAccessRiskWarning}
        onSetExecutionMode={onSetExecutionMode}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Risky switch",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    chooseDropdownOption("Access mode", "Full Access");

    const dialog = screen.getByRole("dialog", { name: "Enable Full Access?" });
    expect(dialog.closest(".composer")).toBeNull();
    expect(dialog.closest(".full-access-warning-modal")).not.toBeNull();
    expect(dialog).toHaveTextContent("network access");
    expect(dialog).toHaveTextContent("read/write access to almost all files");
    expect(dialog).toHaveTextContent("supply chain attack");
    expect(onSetExecutionMode).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByLabelText("Do not warn me again on this desktop."),
    );
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "I Understand and Accept the Risks",
      }),
    );

    await waitFor(() => {
      expect(onDismissFullAccessRiskWarning).toHaveBeenCalledTimes(1);
      expect(onSetExecutionMode).toHaveBeenCalledWith("full-access");
    });
  });

  it("skips the Full Access warning after it has been dismissed", async () => {
    const onSetExecutionMode = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[
          {
            ...backendSummary("codex"),
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
        disabled={false}
        fullAccessRiskWarningDismissed
        onSetExecutionMode={onSetExecutionMode}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Risk accepted",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    chooseDropdownOption("Access mode", "Full Access");

    expect(
      screen.queryByRole("dialog", { name: "Enable Full Access?" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(onSetExecutionMode).toHaveBeenCalledWith("full-access");
    });
  });

  it("disables existing thread workspace handoff while a turn is active", () => {
    const onHandoffThreadWorkspace = vi.fn(async () => undefined);
    const thread = {
      id: "thread-1",
      title: "Build Codex client",
      titleSource: "explicit" as const,
      source: "codex" as const,
      executionMode: "default" as const,
      gitBranch: "feature/handoff",
      linkedDirectories: [
        {
          id: "dir-1",
          label: "PwrAgent",
          path: "/repo",
          kind: "local" as const,
        },
      ],
      inbox: { inInbox: false },
    };

    const { rerender } = render(
      <Composer
        activeTurnId="turn-1"
        backends={[backendSummary("codex")]}
        disabled={false}
        onHandoffThreadWorkspace={onHandoffThreadWorkspace}
        skills={[]}
        thread={thread}
      />
    );

    expect(screen.getByLabelText("Workspace mode")).toBeDisabled();

    rerender(
      <Composer
        activeTurnId={undefined}
        backends={[backendSummary("codex")]}
        disabled={false}
        onHandoffThreadWorkspace={onHandoffThreadWorkspace}
        skills={[]}
        thread={thread}
      />
    );

    expect(screen.getByLabelText("Workspace mode")).toBeEnabled();
  });

  it("disables existing thread workspace handoff when the backend marks it unavailable", () => {
    const onHandoffThreadWorkspace = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[backendSummary("acp:gemini")]}
        disabled={false}
        onHandoffThreadWorkspace={onHandoffThreadWorkspace}
        skills={[]}
        thread={{
          id: "session-1",
          title: "Gemini thread",
          titleSource: "explicit",
          source: "acp:gemini",
          executionMode: "default",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/repo",
              kind: "local",
            },
          ],
          workspaceHandoff: {
            available: false,
            unavailableReason: "ACP live workspace handoff is unsupported.",
          },
          inbox: { inInbox: false },
        }}
      />
    );

    const workspaceMode = screen.getByLabelText("Workspace mode");
    expect(workspaceMode).toBeDisabled();
    expect(workspaceMode).toHaveValue("local");
    fireEvent.click(workspaceMode);
    expect(
      screen.queryByRole("menuitem", { name: "Handoff to New Worktree" })
    ).not.toBeInTheDocument();
  });

  it("does not offer existing thread workspace handoff for non-git Workspaces", () => {
    const projectPath = "/Users/test/.pwragent/profiles/dev/projects/2026-05-23-885b8f";
    const onHandoffThreadWorkspace = vi.fn(async () => undefined);
    const openApplication = vi.fn(async () => ({ opened: true as const }));
    const runCodexEnvironmentAction = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      codexEnvironmentRuntime: {
        environmentId: "workspace-tools",
        environmentName: "Workspace tools",
        executionTarget: "local" as const,
      },
    }));

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
          terminals: [],
          preferredEditorId: { value: "", source: "default" },
          preferredTerminalId: { value: "", source: "default" },
          gh: {
            path: { value: "", source: "default" },
            discovery: { candidates: [] },
          },
          git: {
            discovery: { candidates: [] },
          },
        }}
        backends={[backendSummary("codex")]}
        desktopApi={{ openApplication, runCodexEnvironmentAction }}
        disabled={false}
        onHandoffThreadWorkspace={onHandoffThreadWorkspace}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Create an Agent",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          projectKey: projectPath,
          linkedDirectories: [],
          codexEnvironmentRuntime: {
            environmentId: "workspace-tools",
            environmentName: "Workspace tools",
            executionTarget: "local",
            actions: [
              {
                id: "list-files",
                name: "List files",
                command: "ls",
              },
            ],
          },
          inbox: { inInbox: false },
        }}
      />
    );

    const workspaceMode = screen.queryByLabelText("Workspace mode");
    if (workspaceMode) {
      fireEvent.click(workspaceMode);
    }

    expect(
      screen.queryByRole("menuitem", { name: "Handoff to New Worktree" })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "VS Code" }));
    expect(openApplication).toHaveBeenCalledWith({
      applicationId: "vscode",
      kind: "editor",
      targetPath: projectPath,
    });

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(runCodexEnvironmentAction).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      actionId: "list-files",
      cwd: projectPath,
    });
  });

  it("lets the desktop handoff dialog move the current branch instead", async () => {
    const onHandoffThreadWorkspace = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[backendSummary("codex")]}
        disabled={false}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "PwrAgent",
          path: "/repo",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "feature/handoff",
            defaultBranch: "main",
            branches: ["feature/handoff", "main", "release"],
            handoffBranches: ["main", "release"],
            syncState: "untracked",
          },
        }}
        onHandoffThreadWorkspace={onHandoffThreadWorkspace}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          gitBranch: "feature/handoff",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/repo",
              kind: "local",
            },
          ],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.click(screen.getByLabelText("Workspace mode"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Handoff to New Worktree" }));
    fireEvent.click(screen.getByRole("radio", { name: /Handoff Current Branch/ }));

    expect(screen.getByLabelText("Leave current checkout on")).toHaveValue("HEAD");
    fireEvent.click(screen.getByRole("button", { name: "Handoff" }));

    await waitFor(() => {
      expect(onHandoffThreadWorkspace).toHaveBeenCalledWith({
        direction: "local-to-worktree",
        strategy: "move-branch",
        repositoryPath: "/repo",
        sourcePath: "/repo",
        sourceBranch: "feature/handoff",
        leaveLocalBranch: "HEAD",
      });
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
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "main",
            branches: ["main", "release"],
            syncState: "untracked",
          },
        }}
        launchpad={{
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
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
        "directory:/Users/huntharo/pwrdrvr/PwrAgent",
        expect.objectContaining({ workMode: "worktree" }),
        { stickySettingsChanged: true }
      );
    });
  });

  it("keeps a new-worktree launchpad selected before git status loads", () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "subthread:codex:thread-parent:new-worktree",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={{
          directoryKey: "subthread:codex:thread-parent:new-worktree",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          branchName: "main",
          parentThreadId: "thread-parent",
          parentThreadTitle: "Issue 193 Markdown attachments",
          createdAt: 1,
          updatedAt: 1,
        }}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );

    const workspaceMode = screen.getByLabelText("Workspace mode");
    expect(workspaceMode).toHaveValue("worktree");
    expect(workspaceMode).toHaveTextContent("New worktree");
    expect(screen.getByLabelText("Base branch")).toHaveValue("main");
  });

  it("does not flip a new-worktree launchpad to local when review draft toggles", async () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);
    const launchpad = {
      directoryKey: "subthread:codex:thread-parent:new-worktree",
      directoryKind: "directory" as const,
      directoryLabel: "PwrAgent",
      directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
      backend: "codex" as const,
      executionMode: "default" as const,
      prompt: "",
      workMode: "worktree" as const,
      branchName: "main",
      parentThreadId: "thread-parent",
      parentThreadTitle: "Issue 193 Markdown attachments",
      createdAt: 1,
      updatedAt: 1,
    };

    const { rerender } = render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "subthread:codex:thread-parent:new-worktree",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={launchpad}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );

    const input = screen.getByLabelText("New thread");
    fireEvent.change(input, { target: { value: "/review" } });
    await clickButton("Start thread");
    expect(screen.getByLabelText("Workspace mode")).toHaveValue("worktree");
    expect(screen.getByRole("group", { name: "Review target" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    rerender(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "subthread:codex:thread-parent:new-worktree",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={{ ...launchpad, prompt: "/review", updatedAt: 2 }}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );

    expect(screen.getByLabelText("Workspace mode")).toHaveValue("worktree");
    expect(screen.getByLabelText("Workspace mode")).toHaveTextContent("New worktree");
  });

  it("locks same-worktree sub-thread launchpads to the shared worktree", () => {
    render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "subthread:codex:thread-parent:same-worktree",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/.codex/worktrees/mpsmzvdh/PwrAgnt",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={{
          directoryKey: "subthread:codex:thread-parent:same-worktree",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/.codex/worktrees/mpsmzvdh/PwrAgnt",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          branchName: "feat/messaging-artifact-delivery",
          parentThreadId: "thread-parent",
          parentThreadTitle: "Issue 193 Markdown attachments",
          createdAt: 1,
          updatedAt: 1,
        }}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );

    const workspaceMode = screen.getByLabelText("Workspace mode");
    expect(workspaceMode).toBeDisabled();
    expect(workspaceMode).toHaveValue("local");
    expect(workspaceMode).toHaveTextContent("Same worktree");
    expect(screen.queryByRole("option", { name: "New worktree" })).not.toBeInTheDocument();
  });

  it("does not offer worktree launchpad mode for non-git directories", () => {
    render(
      <Composer
        backends={[
          backendSummary("codex"),
        ]}
        directory={{
          key: "directory:/Users/huntharo/.pwragent/projects",
          kind: "directory",
          label: "Projects",
          path: "/Users/huntharo/.pwragent/projects",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={{
          directoryKey: "directory:/Users/huntharo/.pwragent/projects",
          directoryKind: "directory",
          directoryLabel: "Projects",
          directoryPath: "/Users/huntharo/.pwragent/projects",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        }}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );

    const workspaceMode = screen.getByLabelText("Workspace mode");
    expect(workspaceMode).toBeDisabled();
    expect(workspaceMode).toHaveValue("local");
    expect(workspaceMode).toHaveTextContent("Local");
    fireEvent.click(workspaceMode);
    expect(screen.queryByRole("option", { name: "New worktree" })).not.toBeInTheDocument();
  });

  it("keeps unpublished unborn repositories local and refreshes Git status on hover", () => {
    const unavailableReason =
      "Worktrees are unavailable because this repository has no published base branch yet. Create the initial commit in the Local checkout and publish the default branch. Worktrees will be enabled once a remote base branch is available.";
    const refreshDirectoryGitStatuses = vi.fn(async () => ({ scheduledCount: 1 }));

    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{ refreshDirectoryGitStatuses } as DesktopApi}
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/UnbornRepo",
          kind: "directory",
          label: "UnbornRepo",
          path: "/Users/huntharo/pwrdrvr/UnbornRepo",
          threadKeys: [],
          needsAttentionCount: 0,
          gitStatus: {
            defaultBranch: "seed",
            branches: ["seed"],
            baseBranches: ["seed"],
            syncState: "untracked",
            worktreeCreationAvailable: false,
            worktreeCreationUnavailableReason: unavailableReason,
          },
        }}
        launchpad={{
          directoryKey: "directory:/Users/huntharo/pwrdrvr/UnbornRepo",
          directoryKind: "directory",
          directoryLabel: "UnbornRepo",
          directoryPath: "/Users/huntharo/pwrdrvr/UnbornRepo",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          branchName: "seed",
          createdAt: 1,
          updatedAt: 1,
        }}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );

    const workspaceMode = screen.getByLabelText("Workspace mode");
    expect(workspaceMode).toBeDisabled();
    expect(workspaceMode).toHaveValue("local");
    expect(workspaceMode).toHaveTextContent("Local");
    expect(workspaceMode).toHaveAttribute("aria-description", unavailableReason);
    expect(workspaceMode.closest(".composer-dropdown")).toHaveAttribute(
      "data-tooltip",
      unavailableReason,
    );
    fireEvent.pointerEnter(workspaceMode.closest(".composer-dropdown")!);
    expect(refreshDirectoryGitStatuses).toHaveBeenCalledExactlyOnceWith({
      directoryKeys: ["directory:/Users/huntharo/pwrdrvr/UnbornRepo"],
      force: true,
    });
    expect(screen.queryByRole("option", { name: "New worktree" })).not.toBeInTheDocument();
  });

  it("renders the worktree base branch menu as a branch chooser", () => {
    render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
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
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
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

  it("shows a sticky toast when worktree branch status is unavailable", async () => {
    const onShowNotice = vi.fn();
    render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "subthread:codex:thread-parent:new-worktree",
          kind: "directory",
          label: "giphy-services",
          path: "/missing/giphy-services",
          threadKeys: [],
          needsAttentionCount: 0,
          gitStatus: {
            syncState: "status-unavailable",
            statusUnavailableReason: "fatal: unable to enumerate refs",
          },
        }}
        launchpad={{
          directoryKey: "subthread:codex:thread-parent:new-worktree",
          directoryKind: "directory",
          directoryLabel: "giphy-services",
          directoryPath: "/missing/giphy-services",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          branchName: "deleted-parent-branch",
          parentThreadId: "thread-parent",
          createdAt: 1,
          updatedAt: 1,
        }}
        onShowNotice={onShowNotice}
        skills={[]}
      />
    );

    await waitFor(() => {
      expect(onShowNotice).toHaveBeenCalledWith({
        autoDismiss: false,
        id: expect.stringContaining("launchpad-branches-unavailable:"),
        title: "Branches unavailable",
        message: "PwrAgent couldn't load branches for giphy-services.",
        detail: "fatal: unable to enumerate refs",
        tone: "warning",
      });
    });
  });

  it("shows a sticky toast when branch status removes worktree mode", async () => {
    const onShowNotice = vi.fn();
    render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/repo/app",
          kind: "directory",
          label: "app",
          path: "/repo/app",
          threadKeys: [],
          needsAttentionCount: 0,
          gitStatus: {
            syncState: "status-unavailable",
            statusUnavailableReason: "fatal: unable to enumerate refs",
          },
        }}
        launchpad={{
          directoryKey: "directory:/repo/app",
          directoryKind: "directory",
          directoryLabel: "app",
          directoryPath: "/repo/app",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          createdAt: 1,
          updatedAt: 1,
        }}
        onShowNotice={onShowNotice}
        skills={[]}
      />
    );

    expect(screen.getByLabelText("Workspace mode")).toHaveValue("local");
    expect(
      screen.queryByRole("option", { name: "New worktree" }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(onShowNotice).toHaveBeenCalledWith({
        autoDismiss: false,
        id: expect.stringContaining("launchpad-branches-unavailable:"),
        title: "Branches unavailable",
        message: "PwrAgent couldn't load branches for app.",
        detail: "fatal: unable to enumerate refs",
        tone: "warning",
      });
    });
  });

  it("shows recency, current, and in-use metadata in the branch picker and filters by query", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "main",
            defaultBranch: "main",
            branches: ["feat/telegram-integration", "main", "chore/old"],
            branchDetails: [
              {
                name: "feat/telegram-integration",
                lastCommitAt: nowSeconds - 3 * 86400,
                inUse: true,
              },
              { name: "main", lastCommitAt: nowSeconds - 130 },
              { name: "chore/old", lastCommitAt: nowSeconds - 40 * 86400 },
            ],
            syncState: "in-sync",
          },
        }}
        launchpad={{
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
        }}
        skills={[]}
      />
    );

    fireEvent.click(screen.getByLabelText("Base branch"));

    const inUseOption = screen.getByRole("option", {
      name: "feat/telegram-integration",
    });
    expect(within(inUseOption).getByText("In use")).toBeInTheDocument();
    expect(within(inUseOption).getByText("3d ago")).toBeInTheDocument();

    const currentOption = screen.getByRole("option", { name: "main" });
    expect(within(currentOption).getByText("Current")).toBeInTheDocument();

    // Recency order: feat/telegram-integration (3d) precedes chore/old (40d).
    const optionNames = screen
      .getAllByRole("option")
      .map((option) => option.getAttribute("aria-label"));
    expect(optionNames.indexOf("feat/telegram-integration")).toBeLessThan(
      optionNames.indexOf("chore/old")
    );

    // Typing in the search field filters the list.
    fireEvent.change(screen.getByLabelText("Find a branch"), {
      target: { value: "tele" },
    });
    expect(
      screen.getByRole("option", { name: "feat/telegram-integration" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "main" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "chore/old" })
    ).not.toBeInTheDocument();
  });

  it("shows remote-tracking base refs for new-worktree sub-thread launchpads", async () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);
    render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "subthread:codex:thread-parent:new-worktree",
          kind: "directory",
          label: "GifGrabber",
          path: "/Users/huntharo/.codex/profiles/sstk/worktrees/mqs3ew3f/GifGrabber",
          threadKeys: [],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "fix/upload-mp4-compression",
            defaultBranch: "main",
            branches: ["fix/upload-mp4-compression"],
            branchDetails: [
              {
                name: "fix/upload-mp4-compression",
                lastCommitAt: Math.floor(Date.now() / 1000) - 60,
              },
            ],
            baseBranches: [
              "fix/upload-mp4-compression",
              "origin/main",
              "origin/releases/4.3",
            ],
            baseBranchDetails: [
              {
                name: "fix/upload-mp4-compression",
                lastCommitAt: Math.floor(Date.now() / 1000) - 60,
              },
              {
                name: "origin/main",
                lastCommitAt: Math.floor(Date.now() / 1000) - 3600,
              },
              {
                name: "origin/releases/4.3",
                lastCommitAt: Math.floor(Date.now() / 1000) - 7200,
              },
            ],
            syncState: "untracked",
          },
        }}
        launchpad={{
          directoryKey: "subthread:codex:thread-parent:new-worktree",
          directoryKind: "directory",
          directoryLabel: "GifGrabber",
          directoryPath: "/Users/huntharo/.codex/profiles/sstk/worktrees/mqs3ew3f/GifGrabber",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          branchName: "fix/upload-mp4-compression",
          parentThreadId: "thread-parent",
          parentThreadTitle: "Fix oversized GIPHY uploads",
          createdAt: 1,
          updatedAt: 1,
        }}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );

    fireEvent.click(screen.getByLabelText("Base branch"));

    expect(
      screen.getByRole("option", { name: "fix/upload-mp4-compression" })
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "origin/main" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "origin/releases/4.3" })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("option", { name: "origin/main" }));

    await waitFor(() => {
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "subthread:codex:thread-parent:new-worktree",
        expect.objectContaining({ branchName: "origin/main" }),
        { stickySettingsChanged: true }
      );
    });
  });

  it("pins the selected, default, and current branches above the recency list", () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          threadKeys: [],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "develop",
            defaultBranch: "main",
            branches: ["chore/recent", "feat/x", "develop", "main", "chore/old"],
            branchDetails: [
              { name: "chore/recent", lastCommitAt: nowSeconds - 60 },
              { name: "feat/x", lastCommitAt: nowSeconds - 5 * 86400 },
              { name: "develop", lastCommitAt: nowSeconds - 6 * 86400 },
              { name: "main", lastCommitAt: nowSeconds - 7 * 86400 },
              { name: "chore/old", lastCommitAt: nowSeconds - 30 * 86400 },
            ],
            syncState: "in-sync",
          },
        }}
        launchpad={{
          directoryKey: "directory:/Users/huntharo/pwrdrvr/PwrAgent",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/pwrdrvr/PwrAgent",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          branchName: "feat/x",
          createdAt: 1,
          updatedAt: 1,
        }}
        skills={[]}
      />
    );

    fireEvent.click(screen.getByLabelText("Base branch"));

    const optionNames = screen
      .getAllByRole("option")
      .map((option) => option.getAttribute("aria-label"));
    // Pinned anchors first, in selected -> default -> current priority...
    expect(optionNames.slice(0, 3)).toEqual(["feat/x", "main", "develop"]);
    // ...then the remaining branches in recency order.
    expect(optionNames.slice(3)).toEqual(["chore/recent", "chore/old"]);

    expect(
      screen.getByRole("option", { name: "feat/x" })
    ).toHaveAttribute("aria-selected", "true");
    expect(
      within(screen.getByRole("option", { name: "main" })).getByText("Default")
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("option", { name: "develop" })).getByText("Current")
    ).toBeInTheDocument();
  });

  it("defaults detached new-worktree launchpads to the repository default branch", () => {
    render(
      <Composer
        backends={[backendSummary("codex")]}
        directory={{
          key: "subthread:codex:thread-parent:new-worktree",
          kind: "directory",
          label: "PwrAgent",
          path: "/Users/huntharo/.codex/worktrees/mq8mwn78/PwrAgnt",
          threadKeys: [],
          needsAttentionCount: 0,
          gitStatus: {
            defaultBranch: "main",
            branches: ["fix/layout-chord-single-owner", "main", "release"],
            syncState: "untracked",
          },
        }}
        launchpad={{
          directoryKey: "subthread:codex:thread-parent:new-worktree",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/Users/huntharo/.codex/worktrees/mq8mwn78/PwrAgnt",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "worktree",
          branchName: "HEAD",
          parentThreadId: "thread-parent",
          parentThreadTitle: "Renderer hot CPU profile",
          createdAt: 1,
          updatedAt: 1,
        }}
        skills={[]}
      />
    );

    expect(screen.getByLabelText("Base branch")).toHaveValue("main");
    fireEvent.click(screen.getByLabelText("Base branch"));
    expect(screen.queryByRole("option", { name: "HEAD" })).not.toBeInTheDocument();
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
          gh: {
            path: { value: "", source: "default" },
            discovery: { candidates: [] },
          },
          git: {
            discovery: { candidates: [] },
          },
        }}
        backends={[backendSummary("codex")]}
        desktopApi={{ openApplication }}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "PwrAgent",
          path: "/repo",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
          gitStatus: {
            currentBranch: "main",
            branches: ["main", "feature/handoff"],
          },
        }}
        onHandoffThreadWorkspace={onHandoffThreadWorkspace}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Worktree thread",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          gitBranch: "main",
          observedGitBranch: "HEAD",
          linkedDirectories: [
            {
              id: "dir-1",
              label: "PwrAgent",
              path: "/repo",
              worktreePath: "/repo/.worktrees/pwragent-feature",
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
        targetPath: "/repo/.worktrees/pwragent-feature",
      });
    });

    fireEvent.click(screen.getByLabelText("Workspace mode"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Handoff to Local" }));
    const dialog = screen.getByRole("dialog", { name: "Handoff to Local" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Detached HEAD to move");
    fireEvent.click(screen.getByRole("button", { name: "Handoff" }));

    await waitFor(() => {
      expect(onHandoffThreadWorkspace).toHaveBeenCalledWith({
        direction: "worktree-to-local",
        repositoryPath: "/repo",
        sourcePath: "/repo/.worktrees/pwragent-feature",
        sourceBranch: "HEAD",
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
          gh: {
            path: { value: "", source: "default" },
            discovery: { candidates: [] },
          },
          git: {
            discovery: { candidates: [] },
          },
        }}
        backends={[backendSummary("codex")]}
        desktopApi={{ openApplication }}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "PwrAgent",
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
              label: "PwrAgent",
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

  it("moves the complete active draft onto the project selected from the composer", async () => {
    render(
      <DraftRetargetingHarness previousPwrGitDraft="An older PwrGit draft" />,
    );
    const imageFile = new File(
      [new Uint8Array([1, 2, 3])],
      "wrong-repo-composer.png",
      { type: "image/png" },
    );
    fireEvent.change(screen.getByLabelText("New thread"), {
      target: { value: "Move this text and image to PwrGit" },
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
    expect(
      await screen.findByAltText("wrong-repo-composer.png"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Project: PwrSnap" }));
    fireEvent.click(screen.getByRole("option", { name: /PwrGit/ }));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Project: PwrGit" }),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("New thread")).toHaveValue(
      "Move this text and image to PwrGit",
    );
    expect(screen.getByAltText("wrong-repo-composer.png")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to PwrSnap launchpad" }),
    );
    await waitFor(() => {
      expect(screen.getByLabelText("New thread")).toHaveValue("");
    });
    expect(
      screen.queryByAltText("wrong-repo-composer.png"),
    ).not.toBeInTheDocument();
  });

  it("reveals a project's previous draft after submitting the retargeted top draft", async () => {
    const onMaterializeLaunchpad = vi.fn(async () => undefined);
    render(
      <DraftRetargetingHarness
        previousPwrGitDraft="The PwrGit draft that was already here"
        onMaterializeLaunchpad={onMaterializeLaunchpad}
      />,
    );
    fireEvent.change(screen.getByLabelText("New thread"), {
      target: { value: "Submit this newer draft in PwrGit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Project: PwrSnap" }));
    fireEvent.click(screen.getByRole("option", { name: /PwrGit/ }));

    await waitFor(() => {
      expect(screen.getByLabelText("New thread")).toHaveValue(
        "Submit this newer draft in PwrGit",
      );
    });
    await clickButton("Start thread");
    expect(onMaterializeLaunchpad).toHaveBeenCalledWith(
      retargetingPwrGit.key,
      [{ type: "text", text: "Submit this newer draft in PwrGit" }],
      undefined,
      undefined,
      [],
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to PwrSnap launchpad" }),
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Project: PwrSnap" }),
      ).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Navigate to PwrGit launchpad" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("New thread")).toHaveValue(
        "The PwrGit draft that was already here",
      );
    });
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
    const textarea = screen.getByLabelText("New thread") as HTMLElement & {
      selectionStart: number;
      setSelectionRange: (start: number, end: number) => void;
    };

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

  it("restores a thread reply draft with pasted images after the composer remounts", async () => {
    const draftStore = createComposerDraftStore();
    const imageFile = new File([new Uint8Array([1, 2, 3])], "reply-mockup.png", {
      type: "image/png",
    });
    const thread = {
      id: "thread-1",
      title: "Build Codex client",
      titleSource: "explicit" as const,
      source: "codex" as const,
      linkedDirectories: [],
      inbox: { inInbox: false },
    };

    const { unmount } = render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "turn-1",
          }),
        }}
        draftStore={draftStore}
        disabled={false}
        skills={[]}
        thread={thread}
      />
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "Keep this reply draft" },
    });
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
    expect(await screen.findByAltText("reply-mockup.png")).toBeInTheDocument();

    unmount();
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
        draftStore={draftStore}
        disabled={false}
        skills={[]}
        thread={thread}
      />
    );

    expect(screen.getByLabelText("Reply")).toHaveValue("Keep this reply draft");
    expect(screen.getByAltText("reply-mockup.png")).toBeInTheDocument();
  });

  it("flushes a launchpad draft on unmount before the debounce window expires", async () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);
    const draftStore = createComposerDraftStore();
    const launchpad: NavigationLaunchpadDraft = {
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
    };

    const { unmount } = render(
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
        draftStore={draftStore}
        launchpad={launchpad}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />
    );

    fireEvent.change(screen.getByLabelText("New thread"), {
      target: { value: "Persist this launchpad before navigation" },
    });
    unmount();

    await waitFor(() => {
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        expect.objectContaining({
          prompt: "Persist this launchpad before navigation",
        })
      );
    });
  });

  it("inserts a tilde path from the @ directory autocomplete and links it on start", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const launchpad: NavigationLaunchpadDraft = {
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
      };
      const repoDirectory: NavigationDirectorySummary = {
        key: "directory:/repo",
        kind: "directory",
        label: "Repo",
        path: "/repo",
        threadKeys: [],
        needsAttentionCount: 0,
        latestUpdatedAt: 20,
      };
      const searchProductDirectory: NavigationDirectorySummary = {
        key: "directory:/Users/huntharo/GIPHY/search-product",
        kind: "directory",
        label: "search-product",
        path: "/Users/huntharo/GIPHY/search-product",
        threadKeys: [],
        needsAttentionCount: 0,
        latestUpdatedAt: 10,
      };
      const onMaterializeLaunchpad = vi.fn(async () => undefined);

      render(
        <Composer
          backends={[backendSummary("codex")]}
          directory={repoDirectory}
          directories={[repoDirectory, searchProductDirectory]}
          draftStore={createComposerDraftStore()}
          launchpad={launchpad}
          onMaterializeLaunchpad={onMaterializeLaunchpad}
          onUpdateLaunchpad={async () => undefined}
          skills={[]}
        />
      );

      fireEvent.change(screen.getByLabelText("New thread"), {
        target: { value: "Read SEARCH-4803 in @search" },
      });

      const listbox = screen.getByRole("listbox", { name: "Directories" });
      expect(listbox).toHaveClass("composer__autocomplete--directories");
      fireEvent.click(
        within(listbox).getByRole("button", { name: /search-product/ })
      );

      // The commit mints a zero-width chip: the plain draft keeps only
      // the surrounding text plus the guaranteed post-chip space, the
      // editor shows an @label mention chip, and the serialized draft
      // (asserted on materialize below) carries the markdown link.
      await waitFor(() => {
        expect(screen.getByLabelText("New thread")).toHaveValue(
          "Read SEARCH-4803 in  "
        );
      });
      // Caret parks after the guaranteed post-chip space (set in a
      // requestAnimationFrame after the commit).
      await waitFor(() => {
        expect(
          (screen.getByLabelText("New thread") as HTMLInputElement)
            .selectionStart
        ).toBe("Read SEARCH-4803 in  ".length);
      });
      const richInput = screen.getByTestId("composer-tiptap-input");
      const chip = within(richInput).getByText("@search-product");
      expect(chip).toHaveAttribute("data-mention-kind", "directory");
      expect(chip).toHaveAttribute(
        "data-skill-path",
        "/Users/huntharo/GIPHY/search-product"
      );
      expect(
        screen.queryByRole("listbox", { name: "Directories" })
      ).not.toBeInTheDocument();

      await clickButton("Start thread");

      await waitFor(() => {
        expect(onMaterializeLaunchpad).toHaveBeenCalledWith(
          "directory:/repo",
          [
            {
              type: "text",
              text: "Read SEARCH-4803 in [@search-product](~/GIPHY/search-product)",
            },
          ],
          undefined,
          undefined,
          ["/Users/huntharo/GIPHY/search-product"]
        );
      });
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("rebuilds a directory chip from a prompt-only launchpad restore", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const launchpad: NavigationLaunchpadDraft = {
        directoryKey: "directory:/repo",
        directoryKind: "directory",
        directoryLabel: "Repo",
        directoryPath: "/repo",
        backend: "codex",
        executionMode: "default",
        // Serialized canonical prompt only — no editorDocument, as after
        // an app restart that dropped the rich document.
        prompt: "check [@agent-kit](~/pwrdrvr/agent-kit) please",
        workMode: "local",
        branchName: "main",
        createdAt: 1,
        updatedAt: 1,
      };
      const onMaterializeLaunchpad = vi.fn(async () => undefined);

      render(
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
          directories={[]}
          draftStore={createComposerDraftStore()}
          launchpad={launchpad}
          onMaterializeLaunchpad={onMaterializeLaunchpad}
          onUpdateLaunchpad={async () => undefined}
          skills={[]}
        />
      );

      const richInput = screen.getByTestId("composer-tiptap-input");
      await waitFor(() => {
        expect(within(richInput).getByText("@agent-kit")).toBeInTheDocument();
      });
      expect(within(richInput).getByText("@agent-kit")).toHaveAttribute(
        "data-skill-path",
        "/Users/huntharo/pwrdrvr/agent-kit"
      );

      await clickButton("Start thread");

      // The token alone drives the attach — `directories` is empty, so
      // the text scan cannot resolve this path against a tracked entry.
      await waitFor(() => {
        expect(onMaterializeLaunchpad).toHaveBeenCalledWith(
          "directory:/repo",
          [
            {
              type: "text",
              text: "check [@agent-kit](~/pwrdrvr/agent-kit) please",
            },
          ],
          undefined,
          undefined,
          ["/Users/huntharo/pwrdrvr/agent-kit"]
        );
      });
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("links a hand-typed directory reference after sending a reply", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const startTurn = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        turnId: "turn-1",
      }));
      const onAttachDirectoryReferences = vi.fn();
      const searchProductDirectory: NavigationDirectorySummary = {
        key: "directory:/Users/huntharo/GIPHY/search-product",
        kind: "directory",
        label: "search-product",
        path: "/Users/huntharo/GIPHY/search-product",
        threadKeys: [],
        needsAttentionCount: 0,
        latestUpdatedAt: 10,
      };

      render(
        <Composer
          desktopApi={{
            onAgentEvent: () => () => undefined,
            startTurn,
          }}
          directories={[searchProductDirectory]}
          disabled={false}
          skills={[]}
          onAttachDirectoryReferences={onAttachDirectoryReferences}
          thread={{
            id: "thread-1",
            title: "Search cleanup",
            titleSource: "explicit",
            source: "codex",
            executionMode: "default",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />
      );

      fireEvent.change(screen.getByLabelText("Reply"), {
        target: { value: "It might be in ~/GIPHY/search-product." },
      });
      await clickButton("Send");

      await waitFor(() => {
        expect(startTurn).toHaveBeenCalled();
      });
      expect(onAttachDirectoryReferences).toHaveBeenCalledWith(
        ["/Users/huntharo/GIPHY/search-product"],
        { backend: "codex", threadId: "thread-1" },
      );
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("mints file chips from the @ popover's Add file… action", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const launchpad: NavigationLaunchpadDraft = {
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
      };
      const repoDirectory: NavigationDirectorySummary = {
        key: "directory:/repo",
        kind: "directory",
        label: "Repo",
        path: "/repo",
        threadKeys: [],
        needsAttentionCount: 0,
        latestUpdatedAt: 20,
      };
      const pickFileFromDisk = vi.fn(async () => ({
        canceled: false as const,
        paths: ["/Users/huntharo/notes/spec.md"],
      }));
      const onMaterializeLaunchpad = vi.fn(
        async (..._args: unknown[]) => undefined,
      );

      render(
        <Composer
          backends={[backendSummary("codex")]}
          desktopApi={{
            onAgentEvent: () => () => undefined,
            pickFileFromDisk,
          }}
          directory={repoDirectory}
          directories={[repoDirectory]}
          draftStore={createComposerDraftStore()}
          launchpad={launchpad}
          onMaterializeLaunchpad={onMaterializeLaunchpad}
          onUpdateLaunchpad={async () => undefined}
          skills={[]}
        />
      );

      fireEvent.change(screen.getByLabelText("New thread"), {
        target: { value: "Check @" },
      });

      const listbox = screen.getByRole("listbox", { name: "Directories" });
      // Only the file action renders — this composer has no
      // onPickDirectoryForReference, so the directory action is hidden.
      expect(
        within(listbox).queryByRole("button", { name: "+ Add directory…" })
      ).not.toBeInTheDocument();
      expect(
        within(listbox).getByRole("button", { name: "+ Add file…" })
      ).toBeInTheDocument();
      await clickButton("+ Add file…");

      expect(pickFileFromDisk).toHaveBeenCalledOnce();
      const richInput = screen.getByTestId("composer-tiptap-input");
      await waitFor(() => {
        expect(within(richInput).getByText("@spec.md")).toBeInTheDocument();
      });
      const chip = within(richInput).getByText("@spec.md");
      expect(chip).toHaveAttribute("data-mention-kind", "file");
      expect(chip).toHaveAttribute(
        "data-skill-path",
        "/Users/huntharo/notes/spec.md"
      );
      expect(
        screen.queryByRole("listbox", { name: "Directories" })
      ).not.toBeInTheDocument();

      await clickButton("Start thread");

      await waitFor(() => {
        expect(onMaterializeLaunchpad).toHaveBeenCalled();
      });
      const materializedInput = onMaterializeLaunchpad.mock
        .calls[0][1] as unknown as { type: string; text: string }[];
      expect(materializedInput).toEqual([
        {
          type: "text",
          text: "Check [@spec.md](~/notes/spec.md)",
        },
        {
          type: "localFile",
          name: "spec.md",
          path: "/Users/huntharo/notes/spec.md",
        },
      ]);
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("mints a directory chip from the @ popover's Add directory… action", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const launchpad: NavigationLaunchpadDraft = {
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
      };
      const repoDirectory: NavigationDirectorySummary = {
        key: "directory:/repo",
        kind: "directory",
        label: "Repo",
        path: "/repo",
        threadKeys: [],
        needsAttentionCount: 0,
        latestUpdatedAt: 20,
      };
      const onPickDirectoryForReference = vi.fn(async () => ({
        label: "agent-kit",
        path: "/Users/huntharo/pwrdrvr/agent-kit",
      }));

      render(
        <Composer
          backends={[backendSummary("codex")]}
          directory={repoDirectory}
          directories={[repoDirectory]}
          draftStore={createComposerDraftStore()}
          launchpad={launchpad}
          onMaterializeLaunchpad={async () => undefined}
          onPickDirectoryForReference={onPickDirectoryForReference}
          onUpdateLaunchpad={async () => undefined}
          skills={[]}
        />
      );

      fireEvent.change(screen.getByLabelText("New thread"), {
        target: { value: "Look in @" },
      });

      screen.getByRole("listbox", { name: "Directories" });
      await clickButton("+ Add directory…");

      expect(onPickDirectoryForReference).toHaveBeenCalledOnce();
      const richInput = screen.getByTestId("composer-tiptap-input");
      await waitFor(() => {
        expect(within(richInput).getByText("@agent-kit")).toBeInTheDocument();
      });
      const chip = within(richInput).getByText("@agent-kit");
      expect(chip).toHaveAttribute("data-mention-kind", "directory");
      expect(chip).toHaveAttribute(
        "data-skill-path",
        "/Users/huntharo/pwrdrvr/agent-kit"
      );
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("attaches picked files to the tray from the + Add reference menu", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const pickFileFromDisk = vi.fn(async () => ({
        canceled: false as const,
        paths: ["/Users/huntharo/notes/spec.md"],
      }));

      render(
        <Composer
          desktopApi={{
            onAgentEvent: () => () => undefined,
            pickFileFromDisk,
          }}
          disabled={false}
          skills={[]}
          onPickDirectoryForReference={async () => undefined}
          thread={{
            id: "thread-1",
            title: "Build Codex client",
            titleSource: "explicit",
            source: "codex",
            executionMode: "default",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />
      );

      // While closed, the trigger carries the CSS tooltip.
      expect(
        screen.getByRole("button", { name: "Add reference" })
      ).toHaveAttribute("data-tooltip", "Reference a directory or file");

      await clickButton("Add reference");

      const dialog = screen.getByRole("dialog", { name: "Add reference" });
      // The tooltip is omitted while the popover is open so the
      // pseudo-element can't linger over the panel.
      expect(
        screen.getByRole("button", { name: "Add reference" })
      ).not.toHaveAttribute("data-tooltip");
      // No platform reported → separate add rows (non-macOS behavior).
      expect(
        within(dialog).getByRole("button", { name: "Add directory…" })
      ).toBeInTheDocument();
      await act(async () => {
        fireEvent.click(
          within(dialog).getByRole("button", { name: "Add file…" })
        );
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(pickFileFromDisk).toHaveBeenCalledOnce();
      // The pick lands in the attachment tray as a pill, not as an
      // editor chip, and the picker closes.
      expect(await screen.findByText("spec.md")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Remove spec.md" })
      ).toBeInTheDocument();
      expect(screen.queryByText("@spec.md")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("dialog", { name: "Add reference" })
      ).not.toBeInTheDocument();
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("attaches a recent file to the tray from the reference picker's Files tab", async () => {
    const listRecentFileReferences = vi.fn(async () => ({
      files: [
        { label: "notes.md", path: "/Users/huntharo/notes/notes.md" },
        { label: "todo.txt", path: "/Users/huntharo/notes/todo.txt" },
      ],
    }));
    const recordRecentFileReferences = vi.fn(async () => undefined);

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          listRecentFileReferences,
          recordRecentFileReferences,
          pickFileFromDisk: vi.fn(async () => ({ canceled: true as const })),
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    await clickButton("Add reference");

    expect(listRecentFileReferences).toHaveBeenCalledOnce();
    const dialog = screen.getByRole("dialog", { name: "Add reference" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("tab", { name: "Files" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("option", { name: /notes\.md/ })
      );
      await Promise.resolve();
    });

    // The recent file lands in the attachment tray as a pill and the
    // picker closes; committing it re-records the reference.
    expect(await screen.findByText("notes.md")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove notes.md" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Add reference" })
    ).not.toBeInTheDocument();
    expect(recordRecentFileReferences).toHaveBeenCalledWith({
      paths: ["/Users/huntharo/notes/notes.md"],
    });
  });

  it("mints a directory chip from the reference picker's Projects tab", async () => {
    const launchpad: NavigationLaunchpadDraft = {
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
    };
    const repoDirectory: NavigationDirectorySummary = {
      key: "directory:/repo",
      kind: "directory",
      label: "Repo",
      path: "/repo",
      threadKeys: [],
      needsAttentionCount: 0,
      latestUpdatedAt: 20,
    };

    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{
          onAgentEvent: () => () => undefined,
          pickFileFromDisk: vi.fn(async () => ({ canceled: true as const })),
        }}
        directory={repoDirectory}
        directories={[repoDirectory]}
        draftStore={createComposerDraftStore()}
        launchpad={launchpad}
        onMaterializeLaunchpad={async () => undefined}
        onPickDirectoryForReference={async () => undefined}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );

    await clickButton("Add reference");

    const dialog = screen.getByRole("dialog", { name: "Add reference" });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("option", { name: /Repo/ }));
      await Promise.resolve();
    });

    const richInput = screen.getByTestId("composer-tiptap-input");
    await waitFor(() => {
      expect(within(richInput).getByText("@Repo")).toBeInTheDocument();
    });
    const chip = within(richInput).getByText("@Repo");
    expect(chip).toHaveAttribute("data-mention-kind", "directory");
    expect(chip).toHaveAttribute("data-skill-path", "/repo");
    expect(
      screen.queryByRole("dialog", { name: "Add reference" })
    ).not.toBeInTheDocument();
  });

  it("routes the combined macOS picker's entries to tray pills and directory chips", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const launchpad: NavigationLaunchpadDraft = {
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
      };
      const repoDirectory: NavigationDirectorySummary = {
        key: "directory:/repo",
        kind: "directory",
        label: "Repo",
        path: "/repo",
        threadKeys: [],
        needsAttentionCount: 0,
        latestUpdatedAt: 20,
      };
      const pickReferenceFromDisk = vi.fn(async () => ({
        canceled: false as const,
        entries: [
          {
            path: "/Users/huntharo/notes/spec.md",
            kind: "file" as const,
          },
          {
            path: "/Users/huntharo/pwrdrvr/agent-kit",
            kind: "directory" as const,
          },
        ],
      }));
      // Registration failures are non-fatal — the chip mints anyway and
      // the send-time attach re-registers.
      const registerDirectoryFromDisk = vi.fn(async () => ({
        ok: false as const,
        reason: "not-a-git-repo" as const,
        message: "That folder isn't a git repository.",
      }));

      render(
        <Composer
          backends={[backendSummary("codex")]}
          desktopApi={{
            onAgentEvent: () => () => undefined,
            platform: "darwin",
            pickFileFromDisk: vi.fn(async () => ({ canceled: true as const })),
            pickReferenceFromDisk,
            registerDirectoryFromDisk,
          }}
          directory={repoDirectory}
          directories={[repoDirectory]}
          draftStore={createComposerDraftStore()}
          launchpad={launchpad}
          onMaterializeLaunchpad={async () => undefined}
          onPickDirectoryForReference={async () => undefined}
          onUpdateLaunchpad={async () => undefined}
          skills={[]}
        />
      );

      await clickButton("Add reference");

      const dialog = screen.getByRole("dialog", { name: "Add reference" });
      // macOS gets the single combined action row.
      expect(
        within(dialog).queryByRole("button", { name: "Add directory…" })
      ).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(
          within(dialog).getByRole("button", {
            name: "Add file or directory…",
          })
        );
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(pickReferenceFromDisk).toHaveBeenCalledOnce();
      expect(registerDirectoryFromDisk).toHaveBeenCalledWith({
        path: "/Users/huntharo/pwrdrvr/agent-kit",
      });
      // File → tray pill; directory → editor chip.
      expect(await screen.findByText("spec.md")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Remove spec.md" })
      ).toBeInTheDocument();
      const richInput = screen.getByTestId("composer-tiptap-input");
      await waitFor(() => {
        expect(within(richInput).getByText("@agent-kit")).toBeInTheDocument();
      });
      expect(within(richInput).getByText("@agent-kit")).toHaveAttribute(
        "data-mention-kind",
        "directory"
      );
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("commits a provider slash command insert without looping the draft", async () => {
    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: vi.fn(),
        }}
        disabled={false}
        providerCommands={[
          {
            name: "deployaudit",
            description: "Audit the most recent deploy.",
            backend: "codex",
            scope: "backend",
            source: "provider",
          },
        ]}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Deploy audit",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    const input = screen.getByLabelText("Reply");
    fireEvent.change(input, { target: { value: "/deploy" } });
    expect(
      within(screen.getByRole("listbox", { name: "Commands" })).getByRole(
        "button",
        { name: /\/deployaudit/i },
      ),
    ).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(input).toHaveValue("/deployaudit ");
    });
    expect(
      screen.queryByRole("listbox", { name: "Commands" }),
    ).not.toBeInTheDocument();
  });

  it("does not restore a submitted launchpad draft when materialization unmounts before local clear", async () => {
    const draftStore = createComposerDraftStore();
    const launchpad: NavigationLaunchpadDraft = {
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
    };
    let unmountComposer: () => void = () => undefined;
    const onMaterializeLaunchpad = vi.fn(async () => {
      unmountComposer();
    });

    const { unmount } = render(
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
        draftStore={draftStore}
        launchpad={launchpad}
        onMaterializeLaunchpad={onMaterializeLaunchpad}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );
    unmountComposer = unmount;

    fireEvent.change(screen.getByLabelText("New thread"), {
      target: { value: "Submitted launchpad should not come back" },
    });
    await clickButton("Start thread");

    await waitFor(() => {
      expect(onMaterializeLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        [{ type: "text", text: "Submitted launchpad should not come back" }],
        undefined,
        undefined,
        []
      );
    });

    render(
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
        draftStore={draftStore}
        launchpad={launchpad}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );

    expect(screen.getByLabelText("New thread")).toHaveValue("");
  });

  it("does not restore a submitted launchpad review draft when materialization unmounts before local clear", async () => {
    const draftStore = createComposerDraftStore();
    const launchpad: NavigationLaunchpadDraft = {
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
    };
    let unmountComposer: () => void = () => undefined;
    const onMaterializeLaunchpad = vi.fn(async () => {
      unmountComposer();
    });

    const { unmount } = render(
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
        draftStore={draftStore}
        launchpad={launchpad}
        onMaterializeLaunchpad={onMaterializeLaunchpad}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );
    unmountComposer = unmount;

    fireEvent.change(screen.getByLabelText("New thread"), {
      target: { value: "/review main" },
    });
    await clickButton("Start thread");

    await waitFor(() => {
      expect(onMaterializeLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        undefined,
        undefined,
        { type: "baseBranch", branch: "main" },
        []
      );
    });

    render(
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
        draftStore={draftStore}
        launchpad={launchpad}
        onUpdateLaunchpad={async () => undefined}
        skills={[]}
      />
    );

    expect(screen.getByLabelText("New thread")).toHaveValue("");
  });

  it("preserves launchpad prompt and pasted images when sticky settings change", async () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);
    const imageFile = new File([new Uint8Array([1, 2, 3])], "sticky-mockup.png", {
      type: "image/png",
    });

    render(
      <Composer
        backends={[
          backendSummary("codex", {
            models: [
              { id: "gpt-5.4", label: "GPT 5.4" },
              { id: "gpt-5.5", label: "GPT 5.5" },
            ],
          }),
        ]}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "Repo",
          path: "/repo",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "Repo",
          directoryPath: "/repo",
          backend: "codex",
          executionMode: "default",
          model: "gpt-5.4",
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

    fireEvent.change(screen.getByLabelText("New thread"), {
      target: { value: "Keep this launchpad while changing settings" },
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
    expect(await screen.findByAltText("sticky-mockup.png")).toBeInTheDocument();

    chooseDropdownOption("Model", "GPT 5.5");

    await waitFor(() => {
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        expect.objectContaining({
          imageAttachments: expect.arrayContaining([
            expect.objectContaining({ name: "sticky-mockup.png" }),
          ]),
          model: "gpt-5.5",
          prompt: "Keep this launchpad while changing settings",
        }),
        { stickySettingsChanged: true },
      );
    });
  });

  it("resets one launchpad to the profile model and reasoning baseline", async () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[
          backendSummary("codex", {
            models: [
              {
                id: "gpt-5.5",
                label: "GPT-5.5",
                current: true,
                defaultReasoningEffort: "low",
                reasoningEfforts: ["low", "high"],
                supportsReasoning: true,
              },
              {
                id: "gpt-5.6-sol",
                label: "GPT-5.6-Sol",
                defaultReasoningEffort: "low",
                reasoningEfforts: ["low", "high", "xhigh"],
                supportsReasoning: true,
              },
            ],
          }),
        ]}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "Repo",
          path: "/repo",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "Repo",
          directoryPath: "/repo",
          backend: "codex",
          executionMode: "full-access",
          model: "gpt-5.5",
          reasoningEffort: "low",
          prompt: "keep this prompt",
          workMode: "worktree",
          branchName: "feature/defaults",
          createdAt: 1,
          updatedAt: 1,
        }}
        providerModelDefaults={{
          codex: {
            model: "gpt-5.6-sol",
            reasoningEffortsByModel: {
              "gpt-5.6-sol": "high",
            },
          },
        }}
        onUpdateLaunchpad={onUpdateLaunchpad}
        skills={[]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Reset model and reasoning to profile default",
      }),
    );

    await waitFor(() => {
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        expect.objectContaining({
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
          prompt: "keep this prompt",
        }),
        { stickySettingsChanged: true },
      );
    });
  });

  it("marks ACP privileged launchpad modes as full-access before materialization", async () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[acpGeminiBackendSummary()]}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "Repo",
          path: "/repo",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "Repo",
          directoryPath: "/repo",
          backend: "acp:gemini",
          executionMode: "default",
          acpRuntime: { currentModeId: "default" },
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

    chooseDropdownOption("Agent mode", "Yolo");

    await waitFor(() => {
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        expect.objectContaining({
          acpRuntime: expect.objectContaining({
            currentModeId: "yolo",
          }),
          executionMode: "full-access",
        }),
        { stickySettingsChanged: true },
      );
    });
  });

  it("keeps Gemini Auto Edit launchpad mode in the default execution envelope", async () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[acpGeminiBackendSummary()]}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "Repo",
          path: "/repo",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "Repo",
          directoryPath: "/repo",
          backend: "acp:gemini",
          executionMode: "default",
          acpRuntime: { currentModeId: "default" },
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

    chooseDropdownOption("Agent mode", "Auto Edit");

    await waitFor(() => {
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        expect.objectContaining({
          acpRuntime: expect.objectContaining({
            currentModeId: "autoEdit",
          }),
          executionMode: "default",
        }),
        { stickySettingsChanged: true },
      );
    });
  });

  it("keeps Qwen Auto launchpad mode in the default execution envelope", async () => {
    const onUpdateLaunchpad = vi.fn(async () => undefined);

    render(
      <Composer
        backends={[acpQwenBackendSummary()]}
        directory={{
          key: "directory:/repo",
          kind: "directory",
          label: "Repo",
          path: "/repo",
          threadKeys: [],
          needsAttentionCount: 0,
        }}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "Repo",
          directoryPath: "/repo",
          backend: "acp:qwen",
          executionMode: "default",
          acpRuntime: { configValues: { mode: "default" } },
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

    chooseDropdownOption("Agent mode", "Auto");

    await waitFor(() => {
      expect(onUpdateLaunchpad).toHaveBeenCalledWith(
        "directory:/repo",
        expect.objectContaining({
          acpRuntime: expect.objectContaining({
            configValues: expect.objectContaining({ mode: "auto" }),
          }),
          executionMode: "default",
        }),
        { stickySettingsChanged: true },
      );
    });
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

    // The commit always leaves one space after the chip (the second
    // space here; the first is the one typed before the trigger).
    expect(textarea).toHaveValue("Use  ");
    expect(screen.queryByRole("listbox", { name: "Skills" })).not.toBeInTheDocument();

    await clickButton("Send");

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

  it("prioritizes skill name prefix matches over description-only matches", () => {
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
            name: "adversarial-document-reviewer",
            description: "Conditional reviewer used for CE document stress-testing.",
            path: "/Users/huntharo/.codex/skills/adversarial-document-reviewer/SKILL.md",
            enabled: true,
          },
          {
            name: "ce:plan",
            description: "Transform requirements into implementation plans.",
            path: "/Users/huntharo/.codex/skills/ce-plan/SKILL.md",
            enabled: true,
          },
          {
            name: "ce:work",
            description: "Execute implementation plans.",
            path: "/Users/huntharo/.codex/skills/ce-work/SKILL.md",
            enabled: true,
          },
          {
            name: "architecture-strategist",
            description: "Analyzes patterns and design integrity.",
            path: "/Users/huntharo/.codex/skills/architecture-strategist/SKILL.md",
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

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: { value: "$ce" },
    });

    const options = within(screen.getByRole("listbox", { name: "Skills" }))
      .getAllByRole("button")
      .map((option) => option.textContent ?? "");

    expect(options[0]).toContain("$ce:plan");
    expect(options[1]).toContain("$ce:work");
    expect(options.slice(2).join(" ")).toContain("$adversarial-document-reviewer");
  });

  it("filters skill autocomplete from the reported multi-line draft body", () => {
    renderComposerWithRegressionSkills();

    const input = screen.getByLabelText("Reply");
    fireEvent.change(input, {
      target: { value: `${reportedSkillAutocompleteDraftPrefix}$ce` },
    });

    expect(screen.getByRole("listbox", { name: "Skills" })).toBeInTheDocument();

    fireEvent.change(input, {
      target: { value: `${reportedSkillAutocompleteDraftPrefix}$ce:p` },
    });

    let options = within(screen.getByRole("listbox", { name: "Skills" }))
      .getAllByRole("button")
      .map((option) => option.textContent ?? "");

    expect(options.some((option) => option.includes("$ce:plan"))).toBe(true);

    fireEvent.change(input, {
      target: { value: `${reportedSkillAutocompleteDraftPrefix}$ce:plan` },
    });

    options = within(screen.getByRole("listbox", { name: "Skills" }))
      .getAllByRole("button")
      .map((option) => option.textContent ?? "");

    expect(options[0]).toContain("$ce:plan");
    expect(options[0]).not.toContain("$ce:brainstorm");
  });

  it("commits a skill in the reported multi-line draft without leftover text or extra blank lines", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    renderComposerWithRegressionSkills(startTurn);

    const input = screen.getByLabelText("Reply");
    fireEvent.change(input, {
      target: { value: `${reportedSkillAutocompleteDraftPrefix}$ce:plan` },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    const richInput = screen.getByTestId("composer-tiptap-input");
    expect(within(richInput).getByText("$ce:plan")).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toMatch(/Let's use {2}$/);
    expect(richInput).toHaveTextContent("Let's use");
    expect(richInput).not.toHaveTextContent("Let's use $ce:plan plan");

    await clickButton("Send");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-1",
          input: [
            {
              type: "text",
              text: expect.stringMatching(
                /Let's use \[\$ce:plan\]\(\/Users\/huntharo\/\.codex\/skills\/ce-plan\/SKILL\.md\)$/,
              ),
            },
          ],
        }),
      );
    });
  });

  it("keeps post-skill long-form text recoverable across undo and redo", async () => {
    renderComposerWithRegressionSkills();

    const input = screen.getByLabelText("Reply");
    fireEvent.change(input, {
      target: { value: `${reportedSkillAutocompleteDraftPrefix}$ce:plan` },
    });
    fireEvent.keyDown(input, { key: "Enter" });

    const longBody = [
      "This is the first long paragraph after the inserted skill.",
      "",
      "This is the second paragraph with enough text to look like a real note.",
      "",
      "This is the final sentence before a small accidental deletion.",
    ].join("\n");
    fireEvent.change(input, {
      target: { value: `${reportedSkillAutocompleteDraftPrefix}${longBody}` },
    });
    fireEvent.change(input, {
      target: {
        value: `${reportedSkillAutocompleteDraftPrefix}${longBody.replace(
          "small accidental deletion",
          "small accidental"
        )}`,
      },
    });

    const richInput = screen.getByTestId("composer-tiptap-input");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Reply" }), { key: "z", metaKey: true });

    await waitFor(() => {
      expect(richInput.getAttribute("data-value")).toContain(
        "This is the second paragraph with enough text",
      );
    });
    expect(richInput).toHaveTextContent(
      "This is the second paragraph with enough text"
    );

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Reply" }), { key: "y", metaKey: true });

    await waitFor(() => {
      expect(richInput.getAttribute("data-value")).toContain(
        "This is the second paragraph with enough text",
      );
    });
    expect(richInput).toHaveTextContent(
      "This is the second paragraph with enough text"
    );
  });

  it("cycles durable draft recovery candidates like shell history", async () => {
    const draftStore = createComposerDraftStore();
    const recoveredImageAttachment = {
      id: "image-1",
      name: "diagram.png",
      size: 3,
      type: "image/png",
      url: "data:image/png;base64,AQID",
    };
    const recoveryCandidates: ComposerDraftRecoveryCandidate[] = [
      {
        scopeKey: "thread:codex:thread-1",
        scopeKind: "thread",
        backend: "codex",
        threadId: "thread-1",
        text: "Recovered unsent draft",
        skillTokens: [],
        imageAttachments: [recoveredImageAttachment],
        status: "unsent",
        createdAt: 1,
        updatedAt: 3,
        contentHash: "h1",
        charCount: "Recovered unsent draft".length,
      },
      {
        scopeKey: "thread:codex:thread-1",
        scopeKind: "thread",
        backend: "codex",
        threadId: "thread-1",
        text: "Recovered recently sent draft",
        skillTokens: [],
        imageAttachments: [],
        status: "sent",
        createdAt: 1,
        updatedAt: 2,
        contentHash: "h2",
        charCount: "Recovered recently sent draft".length,
      },
    ];
    draftStore.listRecoveryCandidates = vi.fn(async () => recoveryCandidates);

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: vi.fn(),
        }}
        disabled={false}
        draftStore={draftStore}
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

    const input = screen.getByLabelText("Reply");
    fireEvent.keyDown(input, { key: "ArrowUp" });

    await waitFor(() => {
      expect(input).toHaveValue("Recovered unsent draft");
      expect((input as HTMLTextAreaElement).selectionStart).toBe(0);
    });
    expect(draftStore.listRecoveryCandidates).toHaveBeenCalledWith(
      expect.objectContaining({
        includeSent: true,
        scopeKey: "thread:codex:thread-1",
      }),
    );

    fireEvent.keyDown(input, { key: "ArrowUp" });

    await waitFor(() => {
      expect(input).toHaveValue("Recovered recently sent draft");
      expect((input as HTMLTextAreaElement).selectionStart).toBe(0);
    });

    fireEvent.keyDown(input, { key: "ArrowDown" });

    await waitFor(() => {
      expect(input).toHaveValue("Recovered unsent draft");
      expect((input as HTMLTextAreaElement).selectionStart).toBe(0);
    });

    fireEvent.keyDown(input, { key: "ArrowDown" });

    await waitFor(() => {
      expect(input).toHaveValue("");
    });
  });

  it("does not apply stale async draft recovery after the user types", async () => {
    const draftStore = createComposerDraftStore();
    let resolveRecoveryCandidates:
      | ((candidates: ComposerDraftRecoveryCandidate[]) => void)
      | undefined;
    draftStore.listRecoveryCandidates = vi.fn(
      () =>
        new Promise<ComposerDraftRecoveryCandidate[]>((resolve) => {
          resolveRecoveryCandidates = resolve;
        }),
    );

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: vi.fn(),
        }}
        disabled={false}
        draftStore={draftStore}
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

    const input = screen.getByLabelText("Reply");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.change(input, { target: { value: "New user draft" } });

    await waitFor(() => {
      expect(input).toHaveValue("New user draft");
    });

    await act(async () => {
      resolveRecoveryCandidates?.([
        {
          scopeKey: "thread:codex:thread-1",
          scopeKind: "thread",
          backend: "codex",
          threadId: "thread-1",
          text: "Stale recovered draft",
          skillTokens: [],
          imageAttachments: [],
          status: "unsent",
          createdAt: 1,
          updatedAt: 2,
          contentHash: "stale",
          charCount: "Stale recovered draft".length,
        },
      ]);
      await Promise.resolve();
    });

    await flushReactUpdates();
    expect(input).toHaveValue("New user draft");
  });

  it("falls back to global recovery candidates from a blank composer", async () => {
    const draftStore = createComposerDraftStore();
    const globalCandidate: ComposerDraftRecoveryCandidate = {
      scopeKey: "thread:codex:other-thread",
      scopeKind: "thread",
      backend: "codex",
      threadId: "other-thread",
      text: "Recovered draft from another composer",
      skillTokens: [],
      imageAttachments: [],
      status: "abandoned",
      createdAt: 1,
      updatedAt: 2,
      contentHash: "h-global",
      charCount: "Recovered draft from another composer".length,
    };
    draftStore.listRecoveryCandidates = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([globalCandidate]);

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: vi.fn(),
        }}
        disabled={false}
        draftStore={draftStore}
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

    const input = screen.getByLabelText("Reply");
    fireEvent.keyDown(input, { key: "ArrowUp" });

    await waitFor(() => {
      expect(input).toHaveValue("Recovered draft from another composer");
    });
    expect(draftStore.listRecoveryCandidates).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        includeSent: true,
        scopeKey: "thread:codex:thread-1",
      }),
    );
    expect(draftStore.listRecoveryCandidates).toHaveBeenNthCalledWith(
      2,
      {
        includeSent: true,
        limit: 20,
      },
    );
  });

  it("recovers a meaningful unsent draft after the user deletes it", async () => {
    const draftStore = createComposerDraftStore();
    const recoveryCandidates: ComposerDraftRecoveryCandidate[] = [];
    draftStore.recordHistory = vi.fn((scopeKey, snapshot, status) => {
      recoveryCandidates.unshift({
        scopeKey,
        scopeKind: "thread",
        backend: "codex",
        threadId: "thread-1",
        text: snapshot.draft,
        editorDocument: snapshot.editorDocument,
        skillTokens: snapshot.skillTokens,
        imageAttachments: snapshot.imageAttachments,
        status,
        createdAt: 1,
        updatedAt: 2,
        contentHash: `h${recoveryCandidates.length + 1}`,
        charCount: snapshot.draft.length,
      });
    });
    draftStore.listRecoveryCandidates = vi.fn(async () => recoveryCandidates);
    const deletedDraft =
      "This is a long unsent draft that the user accidentally deleted. " +
      "It has enough detail to be worth recovering from ArrowUp history " +
      "instead of disappearing when the composer becomes empty.";

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: vi.fn(),
        }}
        disabled={false}
        draftStore={draftStore}
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

    const input = screen.getByLabelText("Reply");
    fireEvent.change(input, { target: { value: deletedDraft } });
    await waitFor(() => {
      expect(input).toHaveValue(deletedDraft);
    });

    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => {
      expect(input).toHaveValue("");
    });

    expect(draftStore.recordHistory).toHaveBeenCalledWith(
      "thread:codex:thread-1",
      expect.objectContaining({ draft: deletedDraft }),
      "abandoned",
    );

    fireEvent.keyDown(input, { key: "ArrowUp" });

    await waitFor(() => {
      expect(input).toHaveValue(deletedDraft);
    });
  });

  it("recovers an accidentally deleted no-project draft from the empty composer scope", async () => {
    const draftStore = createComposerDraftStore();
    const recoveryCandidates: ComposerDraftRecoveryCandidate[] = [];
    draftStore.recordHistory = vi.fn((scopeKey, snapshot, status) => {
      recoveryCandidates.unshift({
        scopeKey,
        scopeKind: "empty",
        text: snapshot.draft,
        editorDocument: snapshot.editorDocument,
        skillTokens: snapshot.skillTokens,
        imageAttachments: snapshot.imageAttachments,
        status,
        createdAt: 1,
        updatedAt: 2,
        contentHash: `h-empty-${recoveryCandidates.length + 1}`,
        charCount: snapshot.draft.length,
      });
    });
    draftStore.listRecoveryCandidates = vi.fn(async () => recoveryCandidates);
    const deletedDraft =
      "Somebody once told me\n\n\n\n" +
      "The world is gonna roll me\n\n\n\n" +
      "I ain't the sharpest tool in the shed\n\n\n\n" +
      "```\n// This is a tool\n```\n\n\n\n" +
      "- This is\n- Not exactly a tool";

    render(
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: vi.fn(),
        }}
        disabled={false}
        draftStore={draftStore}
        skills={[]}
      />
    );

    const input = screen.getByLabelText("Reply");
    fireEvent.change(input, { target: { value: deletedDraft } });
    await waitFor(() => {
      expect(input).toHaveValue(deletedDraft);
    });

    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => {
      expect(input).toHaveValue("");
    });

    expect(draftStore.recordHistory).toHaveBeenCalledWith(
      "empty",
      expect.objectContaining({ draft: deletedDraft }),
      "abandoned",
    );

    fireEvent.keyDown(input, { key: "ArrowUp" });

    await waitFor(() => {
      expect(input).toHaveValue(deletedDraft);
    });
  });

  it("hydrates a mounted blank composer when durable drafts load after mount", async () => {
    const draftStore = createComposerDraftStore();
    draftStore.hydrationVersion = 0;
    const thread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Build Codex client",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const renderComposer = () => (
      <Composer
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: vi.fn(),
        }}
        disabled={false}
        draftStore={draftStore}
        skills={[]}
        thread={thread}
      />
    );
    const { rerender } = render(renderComposer());
    const input = screen.getByLabelText("Reply");
    expect(input).toHaveValue("");

    draftStore.set("thread:codex:thread-1", {
      draft: "Hydrated durable draft after startup",
      editorDocument: undefined,
      imageAttachments: [],
      skillTokens: [],
    });
    draftStore.hydrationVersion = 1;
    rerender(renderComposer());

    await waitFor(() => {
      expect(input).toHaveValue("Hydrated durable draft after startup");
    });
  });

  it("does not collapse pasted GitHub paragraph gaps when deleting a trailing blank line", async () => {
    const heading =
      "feat(navigation): replace Inbox tab with user-curated Pins tab (drag-to-pin, reorderable, with auto-switch on drag)";
    const url = "https://github.com/pwrdrvr/PwrAgent/issues/255";
    const firstParagraph =
      "I'm not positive about this... Inbox is kinda duplicated by the top of Recents.  So I think yeah maybe Inbox goes away.  We could replace it with Pins.";
    const secondParagraph =
      "But I think the way that pins work is that they are a scrollable section at the top of Recents and you can click the 3 dots menu to Pin / Unpin a thread on the Recents tab.  If you pin it, it moves up to the bottom of the pinned section.  The pinned section is scrollable and has a divider between the unpinned items below.  The whole list scrolls as one though.  Pins scroll off the top, then the divider, then you're only looking at unpinned threads.";
    const finalParagraph =
      "The pinned threads can be drag/drop re-ordered and the order is saved and restored on startup.";
    const draft = [
      `# ${heading}`,
      "",
      "",
      "",
      url,
      "",
      "",
      "",
      firstParagraph,
      "",
      "",
      "",
      secondParagraph,
      "",
      "",
      "",
      finalParagraph,
    ].join("\n");
    const editorDocument: JSONContent = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: heading }],
        },
        { type: "paragraph" },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: url }] },
        { type: "paragraph" },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: firstParagraph }] },
        { type: "paragraph" },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: secondParagraph }] },
        { type: "paragraph" },
        { type: "paragraph" },
        { type: "paragraph", content: [{ type: "text", text: finalParagraph }] },
        { type: "paragraph" },
        { type: "paragraph" },
      ],
    };
    const draftStore = createComposerDraftStore();
    draftStore.set("thread:codex:thread-1", {
      draft,
      editorDocument,
      imageAttachments: [],
      skillTokens: [],
    });

    render(
      <Composer
        composerImplementation="tiptap-wysiwyg-markdown-chips"
        desktopApi={{
          onAgentEvent: () => () => undefined,
          startTurn: vi.fn(),
        }}
        disabled={false}
        draftStore={draftStore}
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

    const textbox = await screen.findByRole("textbox", { name: "Reply" });
    const blankParagraphsBefore = Array.from(textbox.querySelectorAll("p")).filter(
      (paragraph) => paragraph.textContent === "",
    );
    expect(blankParagraphsBefore.length).toBeGreaterThan(1);

    const lastBlankParagraph = blankParagraphsBefore.at(-1);
    expect(lastBlankParagraph).toBeInTheDocument();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(lastBlankParagraph!);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    textbox.focus();

    fireEvent.keyDown(textbox, { key: "Backspace" });

    await waitFor(() => {
      const blankParagraphsAfter = Array.from(textbox.querySelectorAll("p")).filter(
        (paragraph) => paragraph.textContent === "",
      );
      expect(blankParagraphsAfter).toHaveLength(blankParagraphsBefore.length - 1);
    });
  });

  it("renders selected skill chips without leaving raw mention text", async () => {
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
    fireEvent.change(textarea, { target: { value: "Use $ce:pl" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(within(screen.getByTestId("composer-tiptap-input")).getByText("$ce:plan")).toBeInTheDocument();
    expect(textarea).toHaveValue("Use  ");

    await clickButton("Send");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          {
            type: "text",
            text: "Use [$ce:plan](/Users/huntharo/.codex/skills/ce-plan/SKILL.md)",
          },
        ],
      });
    });
  });

  it.each([
    "019fbbbe-ad52-77c2-b7f7-28182d9a6f83",
    "pwragent://thread/019fbbbe-ad52-77c2-b7f7-28182d9a6f83",
  ])("chipifies a pasted known thread reference and sends its canonical link: %s", async (
    pastedReference,
  ) => {
    const targetThreadId = "019fbbbe-ad52-77c2-b7f7-28182d9a6f83";
    const currentThread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Current thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const targetThread: NavigationThreadSummary = {
      id: targetThreadId,
      title: "Lovely child thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [
        {
          id: "dir-worktree",
          kind: "worktree",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          worktreePath: "/Users/huntharo/.codex/worktrees/child/PwrAgent",
        },
      ],
      inbox: { inInbox: false },
    };
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: currentThread.id,
      turnId: "turn-1",
    }));

    render(
      <ThreadLinkProvider
        onShowThread={() => undefined}
        threads={[currentThread, targetThread]}
      >
        <Composer
          desktopApi={{
            onAgentEvent: () => () => undefined,
            startTurn,
          }}
          disabled={false}
          skills={[]}
          thread={currentThread}
        />
      </ThreadLinkProvider>,
    );

    fireEvent.paste(screen.getByLabelText("Reply"), {
      clipboardData: {
        files: [],
        getData: (type: string) =>
          type === "text/plain" ? pastedReference : "",
        items: [],
        types: ["text/plain"],
      },
    });

    const richInput = screen.getByTestId("composer-tiptap-input");
    const chip = await waitFor(() => {
      const currentChip = within(richInput)
        .getByText("Lovely child thread")
        .closest("[data-mention-kind]");
      expect(currentChip).toHaveAttribute(
        "data-mention-kind",
        "thread",
      );
      return currentChip;
    });
    expect(chip).toHaveAttribute(
      "data-skill-path",
      `pwragent://thread/${targetThreadId}?backend=codex`,
    );
    expect(chip).toHaveAttribute("aria-haspopup", "menu");
    expect(chip).toHaveAttribute("draggable", "false");
    expect(chip?.querySelector("svg")).toHaveAttribute("viewBox", "0 0 24 24");
    expect(screen.getByLabelText("Reply")).toHaveValue(" ");

    const contextMenuEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 80,
    });
    fireEvent(chip!, contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    expect(screen.getByRole("menuitem", { name: "Copy Thread Link" }))
      .toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy Thread ID" }))
      .toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy Thread Name" }))
      .toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy Thread Directory" }))
      .toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });

    await clickButton("Send");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: currentThread.id,
        input: [
          {
            type: "text",
            text: `[Lovely child thread](pwragent://thread/${targetThreadId}?backend=codex)`,
          },
        ],
      });
    });
  });

  it("replaces the selected composer text with a pasted thread chip", async () => {
    const targetThreadId = "019fbbbe-ad52-77c2-b7f7-28182d9a6f83";
    const currentThread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Current thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const targetThread: NavigationThreadSummary = {
      id: targetThreadId,
      title: "Lovely child thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };

    render(
      <ThreadLinkProvider
        onShowThread={() => undefined}
        threads={[currentThread, targetThread]}
      >
        <Composer
          desktopApi={{ onAgentEvent: () => () => undefined }}
          disabled={false}
          skills={[]}
          thread={currentThread}
        />
      </ThreadLinkProvider>,
    );

    const textbox = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.change(textbox, { target: { value: "keep replace tail" } });
    const textNode = textbox.querySelector("p")?.firstChild;
    expect(textNode).toBeInstanceOf(Text);
    textbox.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(textNode!, 5);
    range.setEnd(textNode!, 12);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => type === "text/plain" ? targetThreadId : "",
        items: [],
        types: ["text/plain"],
      },
    });

    await waitFor(() => {
      expect(textbox).toHaveValue("keep  tail");
      expect(
        within(textbox)
          .getByText("Lovely child thread")
          .closest("[data-mention-kind]"),
      ).toHaveAttribute(
        "data-mention-kind",
        "thread",
      );
    });
    expect(textbox).not.toHaveTextContent("replace");
  });

  it("preserves rich composer blocks and marks when pasting a thread chip", async () => {
    const targetThreadId = "019fbbbe-ad52-77c2-b7f7-28182d9a6f83";
    const currentThread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Current thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const targetThread: NavigationThreadSummary = {
      id: targetThreadId,
      title: "Lovely child thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const draftStore = createComposerDraftStore();
    draftStore.set("thread:codex:thread-1", {
      draft: "## Heading\n\n- List item\n\n**keep bold** replace me",
      editorDocument: {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Heading" }],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "List item" }],
                  },
                ],
              },
            ],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "keep bold",
                marks: [{ type: "bold" }],
              },
              { type: "text", text: " replace me" },
            ],
          },
        ],
      },
      imageAttachments: [],
      skillTokens: [],
    });

    render(
      <ThreadLinkProvider
        onShowThread={() => undefined}
        threads={[currentThread, targetThread]}
      >
        <Composer
          composerImplementation="tiptap-wysiwyg-markdown-chips"
          desktopApi={{ onAgentEvent: () => () => undefined }}
          disabled={false}
          draftStore={draftStore}
          skills={[]}
          thread={currentThread}
        />
      </ThreadLinkProvider>,
    );

    const textbox = screen.getByRole("textbox", { name: "Reply" });
    const finalParagraph = textbox.querySelectorAll("p").item(1);
    const replaceTextNode = finalParagraph.lastChild;
    expect(replaceTextNode).toBeInstanceOf(Text);
    textbox.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(replaceTextNode!, 1);
    range.setEnd(replaceTextNode!, " replace me".length);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => type === "text/plain" ? targetThreadId : "",
        items: [],
        types: ["text/plain"],
      },
    });

    await waitFor(() => {
      expect(within(textbox).getByText("Lovely child thread")).toBeInTheDocument();
    });
    expect(textbox.querySelector("h2")).toHaveTextContent("Heading");
    expect(textbox.querySelector("ul li")).toHaveTextContent("List item");
    expect(textbox.querySelector("strong")).toHaveTextContent("keep bold");
    expect(textbox).not.toHaveTextContent("replace me");
  });

  it("submits a pasted thread link through backend steering", async () => {
    const targetThreadId = "019fbbbe-ad52-77c2-b7f7-28182d9a6f83";
    const currentThread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Current thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const targetThread: NavigationThreadSummary = {
      id: targetThreadId,
      title: "$Lovely child thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    const steerTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));

    render(
      <ThreadLinkProvider
        onShowThread={() => undefined}
        threads={[currentThread, targetThread]}
      >
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
          thread={currentThread}
        />
      </ThreadLinkProvider>,
    );

    const textbox = screen.getByRole("textbox", { name: "Reply" });
    fireEvent.paste(textbox, {
      clipboardData: {
        files: [],
        getData: (type: string) => type === "text/plain" ? targetThreadId : "",
        items: [],
        types: ["text/plain"],
      },
    });
    fireEvent.keyDown(textbox, { key: "Enter", metaKey: true });

    await waitFor(() => {
      expect(steerTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          backend: "codex",
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [
            {
              type: "text",
              text: expect.stringContaining(targetThreadId),
            },
          ],
        }),
      );
    });
    expect(screen.getByText("Steering now")).toBeInTheDocument();
    expect(textbox).toHaveValue("");
  });

  it("leaves an unknown pasted thread-shaped id as plain text", async () => {
    const currentThread: NavigationThreadSummary = {
      id: "thread-1",
      title: "Current thread",
      titleSource: "explicit",
      source: "codex",
      linkedDirectories: [],
      inbox: { inInbox: false },
    };
    render(
      <ThreadLinkProvider
        onShowThread={() => undefined}
        threads={[currentThread]}
      >
        <Composer
          desktopApi={{ onAgentEvent: () => () => undefined }}
          disabled={false}
          skills={[]}
          thread={currentThread}
        />
      </ThreadLinkProvider>,
    );

    const unknownId = "019f0000-0000-7000-8000-000000000000";
    fireEvent.paste(screen.getByLabelText("Reply"), {
      clipboardData: {
        files: [],
        getData: (type: string) => type === "text/plain" ? unknownId : "",
        items: [],
        types: ["text/plain"],
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Reply")).toHaveValue(unknownId);
    });
    expect(
      screen.getByTestId("composer-tiptap-input").querySelector(".thread-chip"),
    ).not.toBeInTheDocument();
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
        pastedImageMaxPatches={1024}
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
    expect(normalizeImageFile).toHaveBeenCalledWith(
      imageFile,
      expect.objectContaining({ maxPatchCount: 1024 }),
    );

    await clickButton("Send");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          { type: "text", text: "Describe this screenshot" },
          {
            type: "image",
            name: "screenshot.jpeg",
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

    await clickButton("Send");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          {
            type: "image",
            name: "diagram.png",
            url: expect.stringMatching(/^data:image\/png;base64,/),
          },
        ],
      });
    });
  });

  it("shows pasted image sizes without noisy decimal precision", async () => {
    const startTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      turnId: "turn-1",
    }));
    const normalizedImage = (file: File, size: number) => ({
      conversionPath: "renderer" as const,
      dataUrl: `data:${file.type || "image/png"};base64,AQID`,
      height: 24,
      mimeType: "image/png" as const,
      original: {
        height: 24,
        mimeType: file.type || "image/png",
        name: file.name,
        size: file.size,
        width: 32,
      },
      size,
      width: 32,
    });
    const files = [
      new File([new Uint8Array([1])], "small.png", { type: "image/png" }),
      new File([new Uint8Array([1])], "one-megabyte.png", { type: "image/png" }),
      new File([new Uint8Array([1])], "mid-megabyte.png", { type: "image/png" }),
      new File([new Uint8Array([1])], "large.png", { type: "image/png" }),
    ];

    vi.mocked(normalizeImageFile)
      .mockImplementationOnce(async (file) => normalizedImage(file, 23.7 * 1024))
      .mockImplementationOnce(async (file) => normalizedImage(file, 1 * 1024 * 1024))
      .mockImplementationOnce(async (file) => normalizedImage(file, 1.2 * 1024 * 1024))
      .mockImplementationOnce(async (file) => normalizedImage(file, 10.4 * 1024 * 1024));

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
        files: [],
        items: files.map((file) => ({
          kind: "file",
          type: file.type,
          getAsFile: () => file,
        })),
      },
    });

    expect(await screen.findByText("24 KB")).toBeInTheDocument();
    expect(screen.getByText("1 MB")).toBeInTheDocument();
    expect(screen.getByText("1.2 MB")).toBeInTheDocument();
    expect(screen.getByText("10 MB")).toBeInTheDocument();
  });

  it("renders size and dimension chips above the chat entry and removes an image via the circular control", async () => {
    const file = new File([new Uint8Array([1])], "shot.png", {
      type: "image/png",
    });

    const { container } = render(
      <Composer
        desktopApi={{ onAgentEvent: () => () => undefined }}
        disabled={false}
        skills={[]}
        backends={[backendSummary("codex")]}
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
        files: [],
        items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      },
    });

    // Size + dimension chips (normalizeImageFile mock => 3 bytes, 32x24).
    expect(await screen.findByText("3 B")).toBeInTheDocument();
    expect(screen.getByText("32×24")).toBeInTheDocument();

    // The strip sits before the chat entry in the DOM (req 1 & 6).
    const strip = screen.getByLabelText("Pasted images");
    const input = screen.getByLabelText("Reply");
    expect(
      strip.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    // The circular control removes the attachment.
    fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    await waitFor(() =>
      expect(
        container.querySelectorAll(".composer__attachment-preview")
      ).toHaveLength(0)
    );
  });

  it("stops accepting pasted images at the attachment limit and shows a toast", async () => {
    const onShowNotice = vi.fn();
    const files = Array.from(
      { length: 6 },
      (_, index) =>
        new File([new Uint8Array([1])], `shot-${index}.png`, {
          type: "image/png",
        })
    );
    // Distinct content per file so the cap (not the duplicate guard) is what
    // clamps the batch — identical pastes are de-duplicated separately. The
    // gate clamps 6 → 5 before normalizing, so only 5 files are normalized;
    // queueing exactly 5 `Once` overrides keeps them consumed within this test
    // and never leaks into later tests (afterEach only clears call history).
    for (const file of files.slice(0, 5)) {
      vi.mocked(normalizeImageFile).mockImplementationOnce(async () => ({
        conversionPath: "renderer" as const,
        dataUrl: `data:image/png;base64,${btoa(file.name)}`,
        height: 24,
        mimeType: "image/png" as const,
        original: {
          height: 24,
          mimeType: "image/png",
          name: file.name,
          size: file.size,
          width: 32,
        },
        size: 3,
        width: 32,
      }));
    }

    const { container } = render(
      <Composer
        desktopApi={{ onAgentEvent: () => () => undefined }}
        disabled={false}
        skills={[]}
        backends={[backendSummary("codex")]}
        onShowNotice={onShowNotice}
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
        files: [],
        items: files.map((file) => ({
          kind: "file",
          type: file.type,
          getAsFile: () => file,
        })),
      },
    });

    await waitFor(() =>
      expect(
        container.querySelectorAll(".composer__attachment-preview")
      ).toHaveLength(5)
    );
    expect(onShowNotice).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Attachment limit reached" })
    );
  });

  it("rejects an exact-duplicate paste and keeps a single attachment", async () => {
    const onShowNotice = vi.fn();
    const makeFile = () =>
      new File([new Uint8Array([1])], "shot.png", { type: "image/png" });

    const { container } = render(
      <Composer
        desktopApi={{ onAgentEvent: () => () => undefined }}
        disabled={false}
        skills={[]}
        backends={[backendSummary("codex")]}
        onShowNotice={onShowNotice}
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

    const pasteOnce = () =>
      fireEvent.paste(screen.getByLabelText("Reply"), {
        clipboardData: {
          files: [],
          items: [
            { kind: "file", type: "image/png", getAsFile: () => makeFile() },
          ],
        },
      });

    // The default normalize mock yields identical bytes for both pastes, so
    // the second paste is an exact duplicate of the first.
    pasteOnce();
    await waitFor(() =>
      expect(
        container.querySelectorAll(".composer__attachment-preview")
      ).toHaveLength(1)
    );

    pasteOnce();
    await waitFor(() =>
      expect(onShowNotice).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Image already attached" })
      )
    );
    expect(
      container.querySelectorAll(".composer__attachment-preview")
    ).toHaveLength(1);
  });

  it("rejects pasted images and toasts when the model does not support images", async () => {
    const onShowNotice = vi.fn();
    const file = new File([new Uint8Array([1])], "shot.png", {
      type: "image/png",
    });

    const { container } = render(
      <Composer
        desktopApi={{ onAgentEvent: () => () => undefined }}
        disabled={false}
        skills={[]}
        backends={[
          backendSummary("codex", {
            models: [
              {
                id: "gpt-5.3-codex-spark",
                label: "GPT-5.3-Codex-Spark",
                supportsImage: false,
              },
            ],
          }),
        ]}
        onShowNotice={onShowNotice}
        thread={{
          id: "thread-1",
          title: "Build Codex client",
          titleSource: "explicit",
          source: "codex",
          model: "gpt-5.3-codex-spark",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    fireEvent.paste(screen.getByLabelText("Reply"), {
      clipboardData: {
        files: [],
        items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      },
    });

    expect(onShowNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Images not supported",
        message: expect.stringContaining("GPT-5.3-Codex-Spark"),
        tone: "warning",
      })
    );
    expect(
      container.querySelectorAll(".composer__attachment-preview")
    ).toHaveLength(0);
    expect(normalizeImageFile).not.toHaveBeenCalled();
  });

  it("warns when attachments are already present on a model that doesn't support images", async () => {
    render(
      <Composer
        desktopApi={{ onAgentEvent: () => () => undefined }}
        disabled={false}
        skills={[]}
        backends={[
          backendSummary("codex", {
            models: [
              {
                id: "gpt-5.3-codex-spark",
                label: "GPT-5.3-Codex-Spark",
                supportsImage: false,
              },
            ],
          }),
        ]}
        launchpad={{
          directoryKey: "directory:/repo",
          directoryKind: "directory",
          directoryLabel: "PwrAgent",
          directoryPath: "/repo",
          backend: "codex",
          executionMode: "default",
          prompt: "",
          workMode: "local",
          branchName: "main",
          createdAt: 1,
          updatedAt: 1,
          imageAttachments: [
            {
              id: "seeded-1",
              name: "shot.png",
              size: 24 * 1024,
              type: "image/png",
              url: "data:image/png;base64,AAAA",
            },
          ],
        }}
      />
    );

    // The thumbnail still renders (non-blocking), but a warning naming the
    // model appears so the operator knows the image won't be processed.
    expect(await screen.findByText("24 KB")).toBeInTheDocument();
    const warning = screen.getByText(/doesn't support image attachments/);
    expect(warning).toHaveClass("composer__meta--warning");
    expect(warning.textContent).toContain("GPT-5.3-Codex-Spark");
  });

  it("opens a full-size lightbox when a thumbnail is clicked and closes it via the X", async () => {
    const file = new File([new Uint8Array([1])], "shot.png", {
      type: "image/png",
    });

    render(
      <Composer
        desktopApi={{ onAgentEvent: () => () => undefined }}
        disabled={false}
        skills={[]}
        backends={[backendSummary("codex")]}
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
        files: [],
        items: [{ kind: "file", type: file.type, getAsFile: () => file }],
      },
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Expand shot.png" })
    );

    const dialog = screen.getByRole("dialog", { name: "Expanded image" });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Expanded image" })
      ).not.toBeInTheDocument()
    );
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

    await clickButton("Send");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          {
            type: "image",
            name: "demo.gif",
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

    await clickButton("Send");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        input: [
          {
            type: "image",
            name: "clipboard-item.png",
            url: expect.stringMatching(/^data:image\/png;base64,/),
          },
        ],
      });
    });
  });

  it("attaches a dropped non-image file as a path-only reference and appends it to the sent text", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const startTurn = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        turnId: "turn-1",
      }));
      const notesFile = new File(["notes"], "notes.txt", { type: "text/plain" });

      render(
        <Composer
          desktopApi={{
            onAgentEvent: () => () => undefined,
            getPathForFile: (file: File) => `/Users/huntharo/notes/${file.name}`,
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
      fireEvent.change(textarea, { target: { value: "Look at this" } });
      fireEvent.drop(textarea, {
        dataTransfer: {
          files: [],
          items: [
            { kind: "file", type: "text/plain", getAsFile: () => notesFile },
          ],
        },
      });

      expect(await screen.findByText("notes.txt")).toBeInTheDocument();
      expect(normalizeImageFile).not.toHaveBeenCalled();

      await clickButton("Send");

      await waitFor(() => {
        expect(startTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            input: [
              {
                type: "text",
                text: "Look at this\n\n[@notes.txt](~/notes/notes.txt)",
              },
              {
                type: "localFile",
                name: "notes.txt",
                path: "/Users/huntharo/notes/notes.txt",
              },
            ],
          })
        );
      });
      // The submitted draft clears, and the file pill clears with it.
      await waitFor(() =>
        expect(screen.queryByText("notes.txt")).not.toBeInTheDocument()
      );
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("keeps a 400 MB unsupported TIFF drop as a path-only file reference", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const startTurn = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        turnId: "turn-1",
      }));
      const tiffFile = new File(
        [new Uint8Array([73, 73, 42, 0])],
        "large-scan.tiff",
        { type: "image/tiff" },
      );
      Object.defineProperty(tiffFile, "size", { value: 400 * 1024 * 1024 });

      render(
        <Composer
          desktopApi={{
            onAgentEvent: () => () => undefined,
            getPathForFile: () => "/Users/huntharo/Scans/large-scan.tiff",
            startTurn,
          }}
          disabled={false}
          skills={[]}
          thread={{
            id: "thread-1",
            title: "Inspect scan",
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
            { kind: "file", type: "image/tiff", getAsFile: () => tiffFile },
          ],
        },
      });

      expect(await screen.findByText("large-scan.tiff")).toBeInTheDocument();
      expect(normalizeImageFile).not.toHaveBeenCalled();

      await clickButton("Send");

      await waitFor(() => {
        expect(startTurn).toHaveBeenCalledWith({
          backend: "codex",
          threadId: "thread-1",
          input: [
            {
              type: "text",
              text: "[@large-scan.tiff](~/Scans/large-scan.tiff)",
            },
            {
              type: "localFile",
              name: "large-scan.tiff",
              path: "/Users/huntharo/Scans/large-scan.tiff",
            },
          ],
        });
      });
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("shows the PDF analysis indicator for an extensionless explicit file reference", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const inspectPdfReferencePaths = vi.fn(async ({ paths }: { paths: string[] }) => ({
        filePaths: paths,
        pdfPaths: paths,
      }));
      const jeepFile = new File(["%PDF-1.7"], "Jeep", {
        type: "application/octet-stream",
      });

      render(
        <Composer
          desktopApi={{
            onAgentEvent: () => () => undefined,
            getPathForFile: () => "/Users/huntharo/Downloads/Jeep",
            inspectPdfReferencePaths,
          }}
          disabled={false}
          skills={[]}
          thread={{
            id: "thread-1",
            title: "Compare window stickers",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />
      );

      fireEvent.drop(screen.getByLabelText("Reply"), {
        dataTransfer: {
          files: [],
          items: [
            {
              kind: "file",
              type: "application/octet-stream",
              getAsFile: () => jeepFile,
            },
          ],
        },
      });

      await waitFor(() => {
        expect(inspectPdfReferencePaths).toHaveBeenCalledWith({
          paths: ["/Users/huntharo/Downloads/Jeep"],
        });
      });
      expect(await screen.findByText(/PDF analysis is on\./)).toBeInTheDocument();
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("shows an explicit PDF's local first-page preview without adding it to the turn", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const pdfPath = "/Users/huntharo/Downloads/Jeep";
      const inspectPdfReferencePaths = vi.fn(async () => ({
        filePaths: [pdfPath],
        pdfPaths: [pdfPath],
      }));
      const renderComposerPdfPreview = vi
        .fn()
        .mockResolvedValueOnce({
          dataUrl: "data:image/png;base64,UEZERg==",
          fileIdentity: "pdf-v1",
          height: 480,
          pageCount: 7,
          unchanged: false as const,
          width: 360,
        })
        .mockResolvedValueOnce({
          fileIdentity: "pdf-v1",
          unchanged: true as const,
        });
      const startTurn = vi.fn(async (request: StartTurnRequest) => ({
        backend: request.backend,
        threadId: request.threadId,
        turnId: "turn-1",
      }));
      const jeepFile = new File(["%PDF-1.7"], "Jeep", {
        type: "application/octet-stream",
      });

      render(
        <Composer
          desktopApi={{
            getPathForFile: () => pdfPath,
            inspectPdfReferencePaths,
            onAgentEvent: () => () => undefined,
            renderComposerPdfPreview,
            startTurn,
          }}
          disabled={false}
          skills={[]}
          thread={{
            id: "thread-1",
            title: "Compare window stickers",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />,
      );

      fireEvent.change(screen.getByLabelText("Reply"), {
        target: { value: "Compare the first page" },
      });
      fireEvent.drop(screen.getByLabelText("Reply"), {
        dataTransfer: {
          files: [],
          items: [
            {
              kind: "file",
              type: "application/octet-stream",
              getAsFile: () => jeepFile,
            },
          ],
        },
      });

      expect(
        await screen.findByAltText("Page 1 preview of Jeep"),
      ).toBeInTheDocument();
      expect(screen.getByText("Page 1 of 7")).toBeInTheDocument();
      expect(renderComposerPdfPreview).toHaveBeenCalledWith({ path: pdfPath });

      fireEvent.click(
        screen.getByRole("button", { name: "Expand PDF preview for Jeep" }),
      );
      const dialog = screen.getByRole("dialog", { name: "PDF preview: Jeep" });
      expect(within(dialog).getByText("Jeep · Page 1 of 7")).toBeInTheDocument();

      fireEvent.focus(window);
      await waitFor(() => {
        expect(renderComposerPdfPreview).toHaveBeenLastCalledWith({
          knownFileIdentity: "pdf-v1",
          path: pdfPath,
        });
      });

      await clickButton("Send");
      await waitFor(() => {
        expect(startTurn).toHaveBeenCalledWith({
          backend: "codex",
          threadId: "thread-1",
          input: [
            {
              type: "text",
              text: "Compare the first page\n\n[@Jeep](~/Downloads/Jeep)",
            },
            {
              type: "localFile",
              name: "Jeep",
              path: pdfPath,
            },
          ],
        });
      });
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("does not auto-render a PDF preview while PDF analysis is off", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const pdfPath = "/Users/huntharo/Downloads/Jeep";
      const inspectPdfReferencePaths = vi.fn(async () => ({
        filePaths: [pdfPath],
        pdfPaths: [pdfPath],
      }));
      const renderComposerPdfPreview = vi.fn(async () => ({
        dataUrl: "data:image/png;base64,UEZERg==",
        fileIdentity: "pdf-v1",
        height: 480,
        pageCount: 1,
        unchanged: false as const,
        width: 360,
      }));
      const jeepFile = new File(["%PDF-1.7"], "Jeep", {
        type: "application/octet-stream",
      });

      render(
        <Composer
          desktopApi={{
            getPathForFile: () => pdfPath,
            inspectPdfReferencePaths,
            onAgentEvent: () => () => undefined,
            renderComposerPdfPreview,
          }}
          disabled={false}
          pdfAnalysisEnabled={false}
          skills={[]}
          thread={{
            id: "thread-1",
            title: "Compare window stickers",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />,
      );

      fireEvent.drop(screen.getByLabelText("Reply"), {
        dataTransfer: {
          files: [],
          items: [
            {
              kind: "file",
              type: "application/octet-stream",
              getAsFile: () => jeepFile,
            },
          ],
        },
      });

      expect(await screen.findByRole("button", { name: "Preview" })).toBeInTheDocument();
      expect(renderComposerPdfPreview).not.toHaveBeenCalled();

      await clickButton("Preview");
      await waitFor(() => {
        expect(renderComposerPdfPreview).toHaveBeenCalledWith({ path: pdfPath });
      });
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("shows PDF preview loading and retry states when local rendering fails", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const pdfPath = "/Users/huntharo/Downloads/Jeep";
      const preview = createDeferred<{
        dataUrl: string;
        fileIdentity: string;
        height: number;
        pageCount: number;
        unchanged: false;
        width: number;
      }>();
      const renderComposerPdfPreview = vi.fn(() => preview.promise);
      const jeepFile = new File(["%PDF-1.7"], "Jeep", {
        type: "application/octet-stream",
      });

      render(
        <Composer
          desktopApi={{
            getPathForFile: () => pdfPath,
            inspectPdfReferencePaths: async () => ({
              filePaths: [pdfPath],
              pdfPaths: [pdfPath],
            }),
            onAgentEvent: () => () => undefined,
            renderComposerPdfPreview,
          }}
          disabled={false}
          skills={[]}
          thread={{
            id: "thread-1",
            title: "Compare window stickers",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />,
      );

      fireEvent.drop(screen.getByLabelText("Reply"), {
        dataTransfer: {
          files: [],
          items: [
            {
              kind: "file",
              type: "application/octet-stream",
              getAsFile: () => jeepFile,
            },
          ],
        },
      });

      expect(await screen.findByText("Loading preview")).toBeInTheDocument();
      await act(async () => {
        preview.reject(new Error("PDF is damaged"));
        await preview.promise.catch(() => undefined);
      });
      expect(
        await screen.findByText("Preview unavailable"),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry preview" })).toBeInTheDocument();
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("does not infer PDF analysis from a reference filename suffix", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const inspectPdfReferencePaths = vi.fn(async () => ({
        filePaths: ["/Users/huntharo/Downloads/not-a-pdf.pdf"],
        pdfPaths: [],
      }));

      render(
        <Composer
          desktopApi={{
            inspectPdfReferencePaths,
            onAgentEvent: () => () => undefined,
          }}
          disabled={false}
          skills={[]}
          thread={{
            id: "thread-1",
            title: "Compare window stickers",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />,
      );

      fireEvent.paste(screen.getByRole("textbox", { name: "Reply" }), {
        clipboardData: {
          files: [],
          getData: (type: string) =>
            type === "text/plain"
              ? "Compare [@not-a-pdf.pdf](~/Downloads/not-a-pdf.pdf)"
              : "",
          items: [],
          types: ["text/plain"],
        },
      });

      await waitFor(() => {
        expect(inspectPdfReferencePaths).toHaveBeenCalledWith({
          paths: ["/Users/huntharo/Downloads/not-a-pdf.pdf"],
        });
        expect(
          within(screen.getByTestId("composer-tiptap-input"))
            .getByText("@not-a-pdf.pdf")
            .closest("[data-mention-kind]"),
        ).toHaveAttribute("data-mention-kind", "file");
      });
      expect(screen.queryByText(/PDF analysis is on\./)).not.toBeInTheDocument();
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("hydrates pasted local PDF references before Send without duplicate attachments", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const referencedPaths = [
        "/Users/huntharo/Downloads/Jeep",
        "/Users/huntharo/Downloads/JeepRubicon.pdf",
      ];
      const inspectPdfReferencePaths = vi.fn(async () => ({
        filePaths: referencedPaths,
        pdfPaths: referencedPaths,
      }));
      const startTurn = vi.fn(async (request: StartTurnRequest) => ({
        backend: request.backend,
        threadId: request.threadId,
        turnId: "turn-1",
      }));

      render(
        <Composer
          desktopApi={{
            onAgentEvent: () => () => undefined,
            inspectPdfReferencePaths,
            startTurn,
          }}
          disabled={false}
          skills={[]}
          thread={{
            id: "thread-1",
            title: "Compare window stickers",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />,
      );

      const pastedText = [
        "Help me compare these two Jeeps. What are the key feature differences and cost drivers?",
        "",
        "[@JeepRubicon.pdf](~/Downloads/JeepRubicon.pdf) [@Jeep](~/Downloads/Jeep)",
      ].join("\n");
      const textbox = screen.getByRole("textbox", { name: "Reply" });
      fireEvent.paste(textbox, {
        clipboardData: {
          files: [],
          getData: (type: string) => type === "text/plain" ? pastedText : "",
          items: [],
          types: ["text/plain"],
        },
      });

      await waitFor(() => {
        expect(inspectPdfReferencePaths).toHaveBeenCalledWith({
          paths: referencedPaths,
        });
      });
      const richInput = screen.getByTestId("composer-tiptap-input");
      await waitFor(() => {
        expect(
          within(richInput)
            .getByText("@JeepRubicon.pdf")
            .closest("[data-mention-kind]"),
        ).toHaveAttribute("data-mention-kind", "file");
        expect(
          within(richInput).getByText("@Jeep").closest("[data-mention-kind]"),
        ).toHaveAttribute("data-mention-kind", "file");
      });
      expect(
        await screen.findByText(/PDF analysis is on\./),
      ).toBeInTheDocument();

      await clickButton("Send");

      await waitFor(() => {
        expect(startTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            backend: "codex",
            threadId: "thread-1",
          }),
        );
      });
      const request = startTurn.mock.calls[0]?.[0];
      const localFiles = request?.input.filter(
        (item: { type: string }) => item.type === "localFile",
      );
      expect(localFiles).toEqual([
        {
          type: "localFile",
          name: "JeepRubicon.pdf",
          path: "/Users/huntharo/Downloads/JeepRubicon.pdf",
        },
        {
          type: "localFile",
          name: "Jeep",
          path: "/Users/huntharo/Downloads/Jeep",
        },
      ]);
      expect(request?.input[0]).toEqual({
        type: "text",
        text: pastedText,
      });
      expect(inspectPdfReferencePaths).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("shares a pending pasted-reference inspection with an immediate Send", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const inspection = createDeferred<{
        filePaths: string[];
        pdfPaths: string[];
      }>();
      const inspectPdfReferencePaths = vi.fn(() => inspection.promise);
      const startTurn = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        turnId: "turn-1",
      }));

      render(
        <Composer
          desktopApi={{
            onAgentEvent: () => () => undefined,
            inspectPdfReferencePaths,
            startTurn,
          }}
          disabled={false}
          skills={[]}
          thread={{
            id: "thread-1",
            title: "Compare window stickers",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />,
      );

      const textbox = screen.getByRole("textbox", { name: "Reply" });
      fireEvent.paste(textbox, {
        clipboardData: {
          files: [],
          getData: (type: string) =>
            type === "text/plain" ? "Compare [@Jeep](~/Downloads/Jeep)" : "",
          items: [],
          types: ["text/plain"],
        },
      });

      await waitFor(() => {
        expect(inspectPdfReferencePaths).toHaveBeenCalledWith({
          paths: ["/Users/huntharo/Downloads/Jeep"],
        });
      });
      const form = screen.getByTestId("composer-tiptap-input").closest("form");
      fireEvent.submit(form!);
      fireEvent.submit(form!);
      await flushReactUpdates();
      expect(startTurn).not.toHaveBeenCalled();
      expect(inspectPdfReferencePaths).toHaveBeenCalledTimes(1);

      await act(async () => {
        inspection.resolve({
          filePaths: ["/Users/huntharo/Downloads/Jeep"],
          pdfPaths: ["/Users/huntharo/Downloads/Jeep"],
        });
        await inspection.promise;
      });

      await waitFor(() => {
        expect(startTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            input: [
              { type: "text", text: "Compare [@Jeep](~/Downloads/Jeep)" },
              {
                type: "localFile",
                name: "Jeep",
                path: "/Users/huntharo/Downloads/Jeep",
              },
            ],
          }),
        );
      });
      expect(startTurn).toHaveBeenCalledTimes(1);
      expect(inspectPdfReferencePaths).toHaveBeenCalledTimes(1);
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("does not inspect a plain typed filesystem path", async () => {
    const inspectPdfReferencePaths = vi.fn(async () => ({
      filePaths: [],
      pdfPaths: [],
    }));
    const renderComposerPdfPreview = vi.fn();

    render(
      <Composer
        desktopApi={{
          inspectPdfReferencePaths,
          onAgentEvent: () => () => undefined,
          renderComposerPdfPreview,
        }}
        disabled={false}
        skills={[]}
        thread={{
          id: "thread-1",
          title: "Compare window stickers",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "Compare /Users/huntharo/Downloads/Jeep" },
    });
    await flushReactUpdates();

    expect(inspectPdfReferencePaths).not.toHaveBeenCalled();
    expect(renderComposerPdfPreview).not.toHaveBeenCalled();
  });

  it("hydrates a restored extensionless PDF reference before sending", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const draftStore = createComposerDraftStore();
      draftStore.set("thread:codex:thread-1", {
        draft: "Compare [@Jeep](~/Downloads/Jeep)",
        editorDocument: undefined,
        imageAttachments: [],
        fileAttachments: [],
        skillTokens: [],
      });
      const inspectPdfReferencePaths = vi.fn(async () => ({
        filePaths: ["/Users/huntharo/Downloads/Jeep"],
        pdfPaths: ["/Users/huntharo/Downloads/Jeep"],
      }));
      const renderComposerPdfPreview = vi.fn(async () => ({
        dataUrl: "data:image/png;base64,UEZERg==",
        fileIdentity: "restored-pdf-v1",
        height: 480,
        pageCount: 1,
        unchanged: false as const,
        width: 360,
      }));
      const startTurn = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        turnId: "turn-1",
      }));

      render(
        <Composer
          desktopApi={{
            onAgentEvent: () => () => undefined,
            inspectPdfReferencePaths,
            renderComposerPdfPreview,
            startTurn,
          }}
          disabled={false}
          draftStore={draftStore}
          skills={[]}
          thread={{
            id: "thread-1",
            title: "Compare window stickers",
            titleSource: "explicit",
            source: "codex",
            linkedDirectories: [],
            inbox: { inInbox: false },
          }}
        />,
      );

      await waitFor(() => {
        expect(inspectPdfReferencePaths).toHaveBeenCalledWith({
          paths: ["/Users/huntharo/Downloads/Jeep"],
        });
      });
      const richInput = screen.getByTestId("composer-tiptap-input");
      await waitFor(() => {
        expect(
          within(richInput).getByText("@Jeep").closest("[data-mention-kind]"),
        ).toHaveAttribute("data-mention-kind", "file");
      });
      expect(
        await screen.findByText(/PDF analysis is on\./),
      ).toBeInTheDocument();
      await waitFor(() => {
        expect(renderComposerPdfPreview).toHaveBeenCalledWith({
          path: "/Users/huntharo/Downloads/Jeep",
        });
      });

      await clickButton("Send");

      await waitFor(() => {
        expect(startTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            input: [
              { type: "text", text: "Compare [@Jeep](~/Downloads/Jeep)" },
              {
                type: "localFile",
                name: "Jeep",
                path: "/Users/huntharo/Downloads/Jeep",
              },
            ],
          }),
        );
      });
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("sends a files-only draft as just the reference block", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const startTurn = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        turnId: "turn-1",
      }));
      const notesFile = new File(["notes"], "notes.txt", { type: "text/plain" });

      render(
        <Composer
          desktopApi={{
            onAgentEvent: () => () => undefined,
            getPathForFile: (file: File) => `/Users/huntharo/notes/${file.name}`,
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

      fireEvent.drop(screen.getByLabelText("Reply"), {
        dataTransfer: {
          files: [],
          items: [
            { kind: "file", type: "text/plain", getAsFile: () => notesFile },
          ],
        },
      });

      expect(await screen.findByText("notes.txt")).toBeInTheDocument();

      await clickButton("Send");

      await waitFor(() => {
        expect(startTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            input: [
              { type: "text", text: "[@notes.txt](~/notes/notes.txt)" },
              {
                type: "localFile",
                name: "notes.txt",
                path: "/Users/huntharo/notes/notes.txt",
              },
            ],
          })
        );
      });
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
  });

  it("removes a file attachment via its pill remove button", async () => {
    (window as unknown as { __pwragentHomeDir?: string }).__pwragentHomeDir =
      "/Users/huntharo";
    try {
      const notesFile = new File(["notes"], "notes.txt", { type: "text/plain" });

      render(
        <Composer
          desktopApi={{
            onAgentEvent: () => () => undefined,
            getPathForFile: (file: File) => `/Users/huntharo/notes/${file.name}`,
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

      fireEvent.drop(screen.getByLabelText("Reply"), {
        dataTransfer: {
          files: [],
          items: [
            { kind: "file", type: "text/plain", getAsFile: () => notesFile },
          ],
        },
      });

      expect(await screen.findByText("notes.txt")).toBeInTheDocument();

      fireEvent.click(
        screen.getByRole("button", { name: "Remove notes.txt" })
      );

      await waitFor(() =>
        expect(screen.queryByText("notes.txt")).not.toBeInTheDocument()
      );
    } finally {
      delete (window as unknown as { __pwragentHomeDir?: string })
        .__pwragentHomeDir;
    }
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

    expect(defaultWasPrevented).toBe(true);
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
    fireEvent.keyDown(option, { key: "Enter" });

    expect(within(screen.getByTestId("composer-tiptap-input")).getByText("$ce:plan")).toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toHaveValue(" ");
    expect(screen.queryByRole("listbox", { name: "Skills" })).not.toBeInTheDocument();
  });

  it("moves skill autocomplete by a page with PageDown and PageUp", () => {
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
        skills={Array.from({ length: 12 }, (_, index) => {
          const suffix = String(index + 1).padStart(2, "0");
          return {
            name: `ce:test-${suffix}`,
            description: `Generated test skill ${suffix}`,
            path: `/Users/huntharo/.codex/skills/ce-test-${suffix}/SKILL.md`,
            enabled: true,
          };
        })}
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

    const input = screen.getByLabelText("Reply");
    fireEvent.change(input, { target: { value: "$ce" } });

    const listbox = screen.getByRole("listbox", { name: "Skills" });
    const getActiveOptionIndex = (): number =>
      within(listbox)
        .getAllByRole("button")
        .findIndex((option) => option.getAttribute("aria-selected") === "true");

    expect(getActiveOptionIndex()).toBe(0);

    fireEvent.keyDown(input, { key: "PageDown" });
    expect(getActiveOptionIndex()).toBeGreaterThan(1);

    fireEvent.keyDown(input, { key: "PageUp" });
    expect(getActiveOptionIndex()).toBe(0);

    fireEvent.keyDown(input, { key: "PageUp" });
    expect(getActiveOptionIndex()).toBe(0);

    for (let index = 0; index < 4; index += 1) {
      fireEvent.keyDown(input, { key: "PageDown" });
    }
    expect(getActiveOptionIndex()).toBe(11);
  });

  it("dismisses skill autocomplete when Escape is pressed from a focused option", () => {
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
    fireEvent.keyDown(option, { key: "Escape" });

    expect(screen.queryByRole("listbox", { name: "Skills" })).not.toBeInTheDocument();
    expect(textarea).toHaveValue("$ce:pl");
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
    await clickButton("Send");

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    await clickButton("Stop");

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
                  turnId?: string;
                  turn: {
                    id: string;
                    status: string;
                  } | undefined;
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
    await clickButton("Send");

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-99",
            turn: undefined,
          },
        },
      });
    });

    await clickButton("Stop");

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

  it("keeps messaging-started reviews on the turn that actually completes", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const interruptTurn = vi.fn(async (request) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: request.turnId,
    }));
    const onActiveTurnIdChange = vi.fn();
    const onPendingStatusChange = vi.fn();
    render(
      <Composer
        desktopApi={{
          interruptTurn,
          onAgentEvent: (callback) => {
            agentEventHandler = callback;
            return () => undefined;
          },
        }}
        disabled={false}
        onActiveTurnIdChange={onActiveTurnIdChange}
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

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            item: {
              id: "review-entered",
              type: "enteredReviewMode",
              review: "Review changes against main",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-stray",
            turn: {
              id: "turn-stray",
              status: "inProgress",
            },
          },
        },
      });
    });

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    await clickButton("Stop");
    expect(interruptTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      turnId: "turn-review",
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            turn: {
              id: "turn-review",
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
    expect(onActiveTurnIdChange).not.toHaveBeenCalledWith("turn-stray");
    expect(onActiveTurnIdChange).toHaveBeenLastCalledWith(undefined);
    expect(onPendingStatusChange).toHaveBeenCalledWith("Reviewing");
    expect(onPendingStatusChange).toHaveBeenLastCalledWith(undefined);
  });

  it("clears stale thinking when Stop finds no active backend turn", async () => {
    const interruptTurn = vi.fn(async () => {
      throw new Error("json-rpc error (-32600): no active turn to interrupt");
    });
    const onActiveTurnIdChange = vi.fn();
    const onPendingStatusChange = vi.fn();

    render(
      <Composer
        activeTurnId="turn-stale"
        desktopApi={{
          interruptTurn,
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "turn-1",
          }),
        }}
        disabled={false}
        onActiveTurnIdChange={onActiveTurnIdChange}
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

    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await clickButton("Stop");

    await waitFor(() => {
      expect(interruptTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-stale",
      });
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    });
    expect(onActiveTurnIdChange).toHaveBeenCalledWith(undefined);
    expect(onPendingStatusChange).toHaveBeenCalledWith(undefined);
    expect(
      screen.queryByText(/no active turn to interrupt/i)
    ).not.toBeInTheDocument();
  });

  it("clears stale thinking when Codex reports the thread is idle", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const onActiveTurnIdChange = vi.fn();
    const onPendingStatusChange = vi.fn();

    render(
      <Composer
        activeTurnId="turn-stale"
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-1",
            turnId: "turn-1",
          }),
        }}
        disabled={false}
        onActiveTurnIdChange={onActiveTurnIdChange}
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
      />,
    );

    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: { type: "idle" },
          },
        },
      });
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    });
    expect(onActiveTurnIdChange).toHaveBeenCalledWith(undefined);
    expect(onPendingStatusChange).toHaveBeenCalledWith(undefined);
  });

  it("releases the queued-turn lock when Stop repairs stale active state", async () => {
    const draftStore = createComposerDraftStore();
    const scopeKey = "thread:codex:thread-stale-queue";
    draftStore.setQueuedTurns(scopeKey, [
      {
        id: "queued-1",
        text: "First queued stale turn",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "First queued stale turn" }],
      },
      {
        id: "queued-2",
        text: "Second queued follow-up",
        imageAttachments: [],
        fileAttachments: [],
        input: [{ type: "text", text: "Second queued follow-up" }],
      },
    ]);
    const interruptTurn = vi.fn(async () => {
      throw new Error("json-rpc error (-32600): no active turn to interrupt");
    });
    const startTurn = vi.fn(async (request: StartTurnRequest) => ({
      backend: request.backend,
      threadId: request.threadId,
      turnId: `turn-${startTurn.mock.calls.length}`,
    }));

    render(
      <Composer
        backends={[backendSummary("codex")]}
        desktopApi={{
          interruptTurn,
          startTurn,
        }}
        disabled={false}
        draftStore={draftStore}
        skills={[]}
        thread={{
          id: "thread-stale-queue",
          title: "Stale queued stop",
          titleSource: "explicit",
          source: "codex",
          executionMode: "default",
          linkedDirectories: [],
          inbox: { inInbox: false },
        }}
      />
    );

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
    });
    expect(startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: [{ type: "text", text: "First queued stale turn" }],
      })
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    });
    await clickButton("Stop");

    await waitFor(() => {
      expect(interruptTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-stale-queue",
        turnId: "turn-1",
      });
      expect(startTurn).toHaveBeenCalledTimes(2);
    });
    expect(startTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input: [{ type: "text", text: "Second queued follow-up" }],
      })
    );
  });

  it("keeps confirmed thinking when idle status arrives before completion", async () => {
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
    await clickButton("Send");

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
    await clickButton("Send");

    await waitFor(() => {
      expect(startTurn).toHaveBeenCalledTimes(1);
    });
    expect(startTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "Plan this change" }],
      executionMode: "default",
      collaborationMode: {
        mode: "plan",
        settings: {
          developerInstructions: null,
        },
      },
    });
    expect(onPendingStatusChange).toHaveBeenCalledWith("Planning");
    await waitFor(() => {
      expect(screen.getByLabelText("Plan mode")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  describe("permission-mode queue indicator", () => {
    function baseQueuedThread(overrides: {
      executionMode?: "default" | "full-access";
      queuedExecutionMode?: "default" | "full-access";
    }) {
      return {
        id: "thread-1",
        title: "Permission queue thread",
        titleSource: "explicit" as const,
        source: "codex" as const,
        executionMode: overrides.executionMode ?? ("default" as const),
        queuedExecutionMode: overrides.queuedExecutionMode,
        queuedExecutionModeAt: overrides.queuedExecutionMode
          ? Date.now()
          : undefined,
        linkedDirectories: [],
        inbox: { inInbox: false },
      };
    }

    it("renders the permission queue indicator when a queued mode differs from current", () => {
      render(
        <Composer
          activeTurnId="turn-1"
          backends={[backendSummary("codex")]}
          desktopApi={{ onAgentEvent: () => () => undefined }}
          disabled={false}
          skills={[]}
          thread={baseQueuedThread({
            executionMode: "default",
            queuedExecutionMode: "full-access",
          })}
        />,
      );

      const indicator = screen.getByLabelText("Queued permissions change");
      expect(indicator).toBeInTheDocument();
      expect(indicator.className).toMatch(/composer__queued--permissions/);
      expect(within(indicator).getByText("Permissions queued")).toBeInTheDocument();
      expect(
        within(indicator).getByText(/will switch to full access/i),
      ).toBeInTheDocument();
    });

    it("invokes onCancelExecutionModeQueue when the Cancel button is clicked", async () => {
      const onCancel = vi.fn(async () => undefined);
      render(
        <Composer
          activeTurnId="turn-1"
          backends={[backendSummary("codex")]}
          desktopApi={{ onAgentEvent: () => () => undefined }}
          disabled={false}
          skills={[]}
          thread={baseQueuedThread({
            executionMode: "default",
            queuedExecutionMode: "full-access",
          })}
          onCancelExecutionModeQueue={onCancel}
        />,
      );

      const indicator = screen.getByLabelText("Queued permissions change");
      fireEvent.click(within(indicator).getByRole("button", { name: "Cancel" }));
      await waitFor(() => {
        expect(onCancel).toHaveBeenCalledTimes(1);
      });
    });

    it("does not render the indicator when queuedExecutionMode is undefined", () => {
      render(
        <Composer
          activeTurnId="turn-1"
          backends={[backendSummary("codex")]}
          desktopApi={{ onAgentEvent: () => () => undefined }}
          disabled={false}
          skills={[]}
          thread={baseQueuedThread({
            executionMode: "default",
            queuedExecutionMode: undefined,
          })}
        />,
      );

      expect(
        screen.queryByLabelText("Queued permissions change"),
      ).not.toBeInTheDocument();
    });

    it("does not render the indicator when queuedExecutionMode equals the current mode", () => {
      render(
        <Composer
          activeTurnId="turn-1"
          backends={[backendSummary("codex")]}
          desktopApi={{ onAgentEvent: () => () => undefined }}
          disabled={false}
          skills={[]}
          thread={baseQueuedThread({
            executionMode: "full-access",
            queuedExecutionMode: "full-access",
          })}
        />,
      );

      expect(
        screen.queryByLabelText("Queued permissions change"),
      ).not.toBeInTheDocument();
    });
  });
});
