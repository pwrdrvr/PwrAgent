import "@testing-library/jest-dom/vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopCodexDiscoverySnapshot } from "@pwragent/shared";
import { AppNoticeToast, type AppNoticeToastNotice } from "../AppNoticeToast";
import {
  CODEX_CLI_INSTALL_URL,
  CodexLaunchNotice,
  buildCodexLaunchNotice,
  findCodexLaunchFailure,
} from "../CodexLaunchNotice";
import { appNoticeReducer, INITIAL_APP_NOTICE_STATE } from "../app-notice-state";
import { buildNoStartupBackendNotice } from "../provider-startup-notice";

const command = "/opt/homebrew/bin/codex";
const nativeCommand =
  "/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/"
  + "codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex";
const reason = `Command failed: ${command} --version\nError: spawn ${nativeCommand} ENOENT`;
const broken: DesktopCodexDiscoverySnapshot = {
  candidates: [{
    command,
    executable: false,
    selected: false,
    source: "path",
    failureReason: reason,
  }],
};

afterEach(cleanup);

function NoticeHarness(props: {
  discovery?: DesktopCodexDiscoverySnapshot;
  onOpenCodexSettings?: () => void;
}) {
  const [notice, setNotice] = useState<AppNoticeToastNotice>();
  return (
    <>
      <CodexLaunchNotice
        discovery={props.discovery}
        onNoticeChanged={setNotice}
        onOpenCodexSettings={props.onOpenCodexSettings ?? noop}
      />
      <AppNoticeToast notice={notice} onDismiss={noop} />
    </>
  );
}

function noop(): void {}

describe("Codex launch recovery notice", () => {
  it("shows a sticky toast with settings, install, and copy affordances", () => {
    const onOpenCodexSettings = vi.fn();
    render(<NoticeHarness discovery={broken} onOpenCodexSettings={onOpenCodexSettings} />);

    expect(screen.getByRole("status")).toHaveTextContent("Codex installation failed to start");
    expect(screen.getByRole("status")).toHaveTextContent("Refresh Codex");
    expect(screen.getByRole("definition")).toHaveTextContent(command);
    const guide = screen.getByRole("link", { name: "Codex CLI installation guide" });
    expect(guide).toHaveAttribute("href", CODEX_CLI_INSTALL_URL);
    expect(guide).toHaveAttribute("target", "_blank");
    expect(guide).toHaveAttribute("rel", "noopener noreferrer");
    fireEvent.click(screen.getByRole("button", { name: "Open Codex settings" }));
    expect(onOpenCodexSettings).toHaveBeenCalledOnce();
    expect(buildCodexLaunchNotice({
      failure: { command, reason },
      onDismiss: noop,
      onOpenCodexSettings: noop,
    })).toMatchObject({ autoDismiss: false, copyText: `${command}\n${reason}` });
  });

  it.each(["0.144.0", "0.158.9", "0.159.0", "0.159.0-alpha.2", "0.160.0", "codex-cli 0.160.0", "1.0.0"])(
    "does not warn about an unused broken wrapper with selected Codex %s", (version) => {
      const failedCommand = "/usr/local/bin/codex";
      const discovery: DesktopCodexDiscoverySnapshot = {
        selectedCommand: command,
        candidates: [
          { command, executable: true, selected: true, source: "application", version },
          {
            command: failedCommand,
            executable: true,
            selected: false,
            source: "application",
            versionFailureReason: `Command failed: ${failedCommand} --version\nenv: node: No such file or directory`,
          },
          { command: "/old-nvm/bin/codex", executable: false, selected: false, source: "path", failureReason: "not_executable" },
          { command: "/broken-native/codex", executable: true, selected: false, source: "path", versionFailureReason: "Error: spawn /broken-native/codex ENOENT" },
        ],
      };
      render(<NoticeHarness discovery={discovery} />);

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(findCodexLaunchFailure(discovery)).toBeUndefined();
    },
  );

  it.each(["garbage", undefined])(
    "still reports a broken wrapper when selected Codex %s cannot be verified", (version) => {
      const fallback = "/standalone/codex";
      render(<NoticeHarness discovery={{
        selectedCommand: fallback,
        candidates: [
          { command: fallback, executable: true, selected: true, source: "application", version },
          { command, executable: true, selected: false, source: "path", versionFailureReason: reason },
        ],
      }} />);

      expect(screen.getByRole("status")).toHaveAttribute("data-tone", "warning");
      expect(screen.getByRole("status")).toHaveTextContent("Another working Codex installation is available.");
    },
  );

  it("does not suppress a failure just because an unselected current installation exists", () => {
    render(<NoticeHarness discovery={{
      ...broken,
      candidates: [
        ...broken.candidates,
        { command: "/standalone/codex", executable: true, selected: false, source: "path", version: "0.160.0" },
      ],
    }} />);

    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "error");
  });

  it.each([
    { executable: false },
    { failureReason: "not_executable" },
    { versionFailureReason: reason },
  ])("does not suppress a failure for an unvalidated selected candidate: %o", (failure) => {
    render(<NoticeHarness discovery={{
      selectedCommand: command,
      candidates: [
        { command, executable: true, selected: true, source: "path", version: "0.160.0", ...failure },
        ...broken.candidates,
      ],
    }} />);

    expect(screen.getByRole("status")).toHaveTextContent("Codex installation failed to start");
  });

  it("clears the warning after selecting a validated older runtime while the broken candidate remains", () => {
    const { rerender } = render(<NoticeHarness discovery={broken} />);
    expect(screen.getByRole("status")).toBeInTheDocument();

    rerender(<NoticeHarness discovery={{
      selectedCommand: "/standalone/codex",
      candidates: [
        ...broken.candidates,
        { command: "/standalone/codex", executable: true, selected: true, source: "config", version: "0.144.0" },
      ],
    }} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rerender(<NoticeHarness discovery={broken} />);
    expect(screen.getByRole("status")).toHaveTextContent("Codex installation failed to start");
  });

  it.each([
    ["codex.CMD", "Command failed: cmd.exe /d /s /c \"C:\\Tools\\codex.CMD --version\"\n'node' is not recognized"],
    ["codex.EXE", "Command failed: C:\\Tools\\codex.EXE --version"],
    ["CODEX.EXE", "Error: spawn C:\\Tools\\CODEX.EXE ENOENT"],
  ])("reports a failed Windows %s executable", (executable, failureReason) => {
    render(<NoticeHarness discovery={{
      candidates: [{
        command: `C:\\Tools\\${executable}`,
        executable: true,
        selected: false,
        source: "path",
        versionFailureReason: failureReason,
      }],
    }} />);

    expect(screen.getByRole("status")).toHaveTextContent("Codex installation failed to start");
    expect(screen.getByRole("button", { name: "Open Codex settings" })).toBeInTheDocument();
  });

  it.each(["not_found", "codex_too_old", "version_not_reported", "version_probe_timed_out"])(
    "does not misdiagnose %s as a broken installation", (failureReason) => {
      expect(findCodexLaunchFailure({
        candidates: [{ ...broken.candidates[0]!, failureReason }],
      })).toBeUndefined();
    },
  );

  it("keeps a dismissed incident hidden across unrelated settings updates", () => {
    const { rerender } = render(<NoticeHarness discovery={broken} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rerender(<NoticeHarness discovery={{ ...broken, candidates: [...broken.candidates] }} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("clears after repair and reports a later failure of the same installation", () => {
    const { rerender } = render(<NoticeHarness discovery={broken} />);
    rerender(<NoticeHarness discovery={{
      selectedCommand: command,
      candidates: [{ command, executable: true, selected: true, source: "path", version: "0.160.0" }],
    }} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    rerender(<NoticeHarness discovery={broken} />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    rerender(<NoticeHarness discovery={{ candidates: [] }} />);
    rerender(<NoticeHarness discovery={broken} />);
    expect(screen.getByRole("status")).toHaveTextContent("Codex installation failed to start");
  });

  it("coalesces the generic startup warning in either delivery order", () => {
    const generic = buildNoStartupBackendNotice({
      backends: [{
        kind: "codex",
        label: "Codex",
        source: "builtin",
        available: false,
        methods: [],
        executionModes: [],
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
      }],
      onDismiss: noop,
      onOpenProviderSettings: noop,
      onRunSetup: noop,
    });
    const specific = buildCodexLaunchNotice({
      failure: { command, reason },
      onDismiss: noop,
      onOpenCodexSettings: noop,
    });
    for (const notices of [[generic, specific], [specific, generic]]) {
      const state = notices.reduce(
        (state, notice) => appNoticeReducer(state, { type: "show", notice }),
        INITIAL_APP_NOTICE_STATE,
      );
      expect(state.durable).toEqual([specific]);
    }
  });
});
