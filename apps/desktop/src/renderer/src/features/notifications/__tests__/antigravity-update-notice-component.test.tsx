import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpAgentSettingsEntry } from "@pwragent/shared/contracts/backend";
import type { AntigravitySetupRequest, AntigravitySetupResult } from "../../../../../shared/antigravity-setup";
import type { DesktopApi } from "../../../lib/desktop-api";
import { BACKEND_SUMMARIES_REFRESH_EVENT } from "../../../lib/useBackendSummaries";
import type { AppNoticeToastNotice } from "../AppNoticeToast";
import { AntigravityUpdateNotice } from "../AntigravityUpdateNotice";

const ROOT = "/Users/contrived/.pwragent/agents/antigravity";
const managedCommand = (version: string) => `${ROOT}/versions/${version}-${"a".repeat(128)}/agy`;

type Setup = (request: AntigravitySetupRequest) => Promise<AntigravitySetupResult>;

function noticeApi(params: { activeCommand?: string; enabled?: boolean; setup: Setup }) {
  const entry = {
    registryId: "antigravity",
    enabled: params.enabled ?? true,
    installed: true,
    activeCommand: params.activeCommand,
  } as AcpAgentSettingsEntry;
  const antigravitySetup = vi.fn(params.setup);
  const api = {
    antigravitySetup,
    listAcpAgents: vi.fn(async () => ({ entries: [entry] })),
  } as unknown as DesktopApi;
  return { api, antigravitySetup };
}

function installed(version: string): AntigravitySetupResult {
  return { ok: true, runtime: { status: "installed", runtime: { command: managedCommand(version), version } } };
}

function lastNotice(spy: ReturnType<typeof vi.fn>): AppNoticeToastNotice | undefined {
  return spy.mock.calls.at(-1)?.[0] as AppNoticeToastNotice | undefined;
}

describe("Antigravity startup notice", () => {
  afterEach(cleanup);

  it("asks Google nothing for a user running their own agy, or with Antigravity off", async () => {
    for (const params of [
      { activeCommand: "/opt/contrived/agy" },
      { activeCommand: managedCommand("1.5.15"), enabled: false },
    ]) {
      const { api, antigravitySetup } = noticeApi({
        ...params,
        setup: async (request) => request.action === "check-update"
          ? { ...installed("1.5.15"), release: { latestVersion: "1.5.16", checkedAt: 1 } }
          : installed("1.5.15"),
      });
      const onNoticeChanged = vi.fn();
      render(<AntigravityUpdateNotice desktopApi={api} onNoticeChanged={onNoticeChanged} onOpenSettings={vi.fn()} />);
      await waitFor(() => expect(api.listAcpAgents).toHaveBeenCalled());
      await act(async () => undefined);
      expect(antigravitySetup).not.toHaveBeenCalledWith(expect.objectContaining({ action: "check-update" }));
      expect(lastNotice(onNoticeChanged)).toBeUndefined();
      cleanup();
    }
  });

  it("offers the newer release when the managed install runs new threads", async () => {
    const { api } = noticeApi({
      activeCommand: `${ROOT}/active`,
      setup: async (request) => request.action === "check-update"
        ? { ...installed("1.5.15"), release: { latestVersion: "1.5.16", checkedAt: 1 } }
        : installed("1.5.15"),
    });
    const onNoticeChanged = vi.fn();
    render(<AntigravityUpdateNotice desktopApi={api} onNoticeChanged={onNoticeChanged} onOpenSettings={vi.fn()} />);
    await waitFor(() => expect(lastNotice(onNoticeChanged)?.id).toBe("antigravity-update:1.5.16"));
  });

  it("goes from the running update straight to the success notice, never back to the offer", async () => {
    let version = "1.5.15";
    const { api } = noticeApi({
      activeCommand: `${ROOT}/active`,
      setup: async (request) => {
        if (request.action === "install") {
          version = "1.5.16";
          return installed("1.5.16");
        }
        return request.action === "check-update"
          ? { ...installed(version), release: { latestVersion: "1.5.16", checkedAt: 1 } }
          : installed(version);
      },
    });
    const onNoticeChanged = vi.fn();
    render(<AntigravityUpdateNotice desktopApi={api} onNoticeChanged={onNoticeChanged} onOpenSettings={vi.fn()} />);
    await waitFor(() => expect(lastNotice(onNoticeChanged)?.actions?.length).toBe(2));
    const clickedAt = onNoticeChanged.mock.calls.length;
    await act(async () => {
      lastNotice(onNoticeChanged)?.actions?.[0]?.onClick();
    });
    await waitFor(() => expect(lastNotice(onNoticeChanged)?.title).toBe("Antigravity updated"));
    // Once Update is clicked, the offer's buttons do not come back: each
    // return re-grew the card under the pointer before the success notice.
    const after = onNoticeChanged.mock.calls.slice(clickedAt).map(([notice]) => notice as AppNoticeToastNotice | undefined);
    expect(after.filter((notice) => notice?.id === "antigravity-update:1.5.16" && (notice.actions?.length ?? 0) > 0)).toEqual([]);
  });

  it("lets a check begun before an install never restore the old runtime", async () => {
    let version = "1.5.15";
    let releaseStale: (() => void) | undefined;
    let checks = 0;
    const { api } = noticeApi({
      activeCommand: `${ROOT}/active`,
      setup: async (request) => {
        if (request.action !== "check-update") return installed(version);
        checks += 1;
        // The first check reads the runtime, then waits on a slow Google.
        const answer = { ...installed(version), release: { latestVersion: "1.5.16", checkedAt: 1 } };
        if (checks === 1) await new Promise<void>((resolve) => { releaseStale = resolve; });
        return answer;
      },
    });
    const onNoticeChanged = vi.fn();
    render(<AntigravityUpdateNotice desktopApi={api} onNoticeChanged={onNoticeChanged} onOpenSettings={vi.fn()} />);
    await waitFor(() => expect(releaseStale).toBeDefined());
    // Another surface installs 1.5.16 and raises a refresh.
    version = "1.5.16";
    await act(async () => {
      window.dispatchEvent(new Event(BACKEND_SUMMARIES_REFRESH_EVENT));
    });
    await waitFor(() => expect(checks).toBe(2));
    await act(async () => {
      releaseStale?.();
    });
    await act(async () => undefined);
    expect(onNoticeChanged.mock.calls.some(([notice]) => notice?.id === "antigravity-update:1.5.16")).toBe(false);
  });
});
