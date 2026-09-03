import { describe, expect, it, vi } from "vitest";
import type { BackendSummary } from "@pwragent/shared";
import {
  buildNoStartupBackendNotice,
  NO_STARTUP_BACKEND_NOTICE_ID,
} from "../provider-startup-notice";

function codexSummary(unavailableReason?: string): BackendSummary {
  return {
    kind: "codex",
    source: "builtin",
    label: "Codex",
    available: false,
    methods: [],
    capabilities: {
      listThreads: false,
      createThread: false,
      resumeThread: false,
      renameThread: false,
      readThread: false,
      startTurn: false,
      interruptTurn: false,
      steerTurn: false,
      transcriptPagination: false,
      toolUse: false,
      approvalRequests: false,
      multiDirectoryThreads: false,
    },
    executionModes: [],
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}

describe("buildNoStartupBackendNotice", () => {
  it("leads with provider settings and keeps setup as the secondary answer", () => {
    const onOpenCodexSettings = vi.fn();
    const onRunSetup = vi.fn();

    const notice = buildNoStartupBackendNotice({
      codex: codexSummary("Codex CLI 0.1.0 is older than the minimum."),
      onOpenCodexSettings,
      onRunSetup,
    });

    expect(notice).toMatchObject({
      autoDismiss: false,
      detail: "Codex: Codex CLI 0.1.0 is older than the minimum.",
      id: NO_STARTUP_BACKEND_NOTICE_ID,
      title: "No agent backend is available",
      tone: "warning",
    });
    // The operator has already completed onboarding, so the first answer must
    // be the pane that reports provider health, not a wizard that asks them to
    // redo choices they already made.
    expect(notice.actions?.map((action) => action.label)).toEqual([
      "Open AI Providers",
      "Run setup",
    ]);
    expect(notice.actions?.[0]?.tone).toBe("primary");

    notice.actions?.[0]?.onClick();
    notice.actions?.[1]?.onClick();
    expect(onOpenCodexSettings).toHaveBeenCalledTimes(1);
    expect(onRunSetup).toHaveBeenCalledTimes(1);
  });

  it("omits the detail line when no provider reported a reason", () => {
    const notice = buildNoStartupBackendNotice({
      codex: codexSummary(),
      onOpenCodexSettings: vi.fn(),
      onRunSetup: vi.fn(),
    });

    expect(notice).not.toHaveProperty("detail");
    expect(notice).not.toHaveProperty("copyText");
  });
});
