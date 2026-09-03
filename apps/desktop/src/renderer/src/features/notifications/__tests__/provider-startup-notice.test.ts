import { describe, expect, it, vi } from "vitest";
import type { AppServerBackendKind, BackendSummary } from "@pwragent/shared";
import {
  buildNoStartupBackendNotice,
  NO_STARTUP_BACKEND_NOTICE_ID,
} from "../provider-startup-notice";

function summary(params: {
  kind: AppServerBackendKind;
  label: string;
  unavailableReason?: string;
}): BackendSummary {
  return {
    kind: params.kind,
    source: params.kind.startsWith("acp:") ? "acp" : "builtin",
    label: params.label,
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
    ...(params.unavailableReason
      ? { unavailableReason: params.unavailableReason }
      : {}),
  };
}

describe("buildNoStartupBackendNotice", () => {
  it("leads with provider settings and keeps setup as the secondary answer", () => {
    const onOpenProviderSettings = vi.fn();
    const onRunSetup = vi.fn();

    const notice = buildNoStartupBackendNotice({
      backends: [
        summary({
          kind: "codex",
          label: "Codex",
          unavailableReason: "Codex CLI 0.1.0 is older than the minimum.",
        }),
      ],
      onDismiss: vi.fn(),
      onOpenProviderSettings,
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
    expect(onOpenProviderSettings).toHaveBeenCalledWith("codex");
    expect(onRunSetup).toHaveBeenCalledTimes(1);
  });

  it("names the provider that reported a reason, not whichever came first", () => {
    const onOpenProviderSettings = vi.fn();

    const notice = buildNoStartupBackendNotice({
      backends: [
        summary({ kind: "codex", label: "Codex" }),
        summary({
          kind: "acp:gemini",
          label: "Gemini",
          unavailableReason: "gemini CLI is not installed.",
        }),
      ],
      onDismiss: vi.fn(),
      onOpenProviderSettings,
      onRunSetup: vi.fn(),
    });

    // `!startupBackend` means "nothing is selectable", not "Codex is broken".
    // Hardcoding Codex sent operators on an ACP-only profile to a provider
    // they never configured while the missing one went unnamed.
    expect(notice.detail).toBe("Gemini: gemini CLI is not installed.");
    notice.actions?.[0]?.onClick();
    expect(onOpenProviderSettings).toHaveBeenCalledWith("gemini");
  });

  it("omits the detail line when no provider reported a reason", () => {
    const notice = buildNoStartupBackendNotice({
      backends: [summary({ kind: "codex", label: "Codex" })],
      onDismiss: vi.fn(),
      onOpenProviderSettings: vi.fn(),
      onRunSetup: vi.fn(),
    });

    expect(notice).not.toHaveProperty("detail");
    expect(notice).not.toHaveProperty("copyText");
  });

  it("dismisses through the caller so the landing decision can reset", () => {
    const onDismiss = vi.fn();

    const notice = buildNoStartupBackendNotice({
      backends: [],
      onDismiss,
      onOpenProviderSettings: vi.fn(),
      onRunSetup: vi.fn(),
    });

    // A notice-supplied `onDismiss` replaces the stack's own removal, so the
    // caller owns both resetting the ref and dropping the notice.
    notice.onDismiss?.();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
