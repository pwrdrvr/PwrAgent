import fc from "fast-check";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FederationHealthStatus } from "@pwragent/shared";
import { FederationDisplayLabelsProvider } from "../../../lib/federation-display-label";
import { AppNoticeToast } from "../AppNoticeToast";
import { resolveThreadActionErrorNotice } from "../thread-action-error-notice";

afterEach(cleanup);

function renderNotice(message: string, health?: FederationHealthStatus): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <FederationDisplayLabelsProvider health={health}>
      <AppNoticeToast
        notice={resolveThreadActionErrorNotice({ kind: "archive-thread", message })}
        onDismiss={() => undefined}
      />
    </FederationDisplayLabelsProvider>,
  );
  return container.querySelector<HTMLElement>(".app-notice-toast__message")!;
}

function peerHealth(instanceId: string, shortLabel?: string): FederationHealthStatus {
  return {
    enabled: true, role: "gateway", status: "listening",
    peers: [{
      id: instanceId, label: "Showcase-Mac-Studio", shortLabel,
      role: "client", status: "disconnected", capabilities: [],
    }],
  };
}

describe("offline peer action notices", () => {
  it("copies the thread reference, failed checkout and original error from the notice button", () => {
    const message = "Federation peer fixture-peer is not connected.";
    const copyText = vi.fn(async () => undefined);
    const notice = resolveThreadActionErrorNotice({ kind: "archive-thread", message,
      threadLink: { backend: "codex", instanceId: "fixture-peer", threadId: "00000000-0000-1000-8000-000000000000", title: "Repair build caching" },
      worktreePaths: ["/contrived/worktrees/00000000-0000-1000-8000-000000000000"],
    });
    render(<AppNoticeToast notice={notice} desktopApi={{ copyText }} onDismiss={() => undefined} onOpenThread={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy notice" }));
    expect(copyText).toHaveBeenCalledExactlyOnceWith(notice.copyText);
    for (const value of ["Repair build caching", "00000000-0000-1000-8000-000000000000", "/contrived/worktrees/00000000-0000-1000-8000-000000000000", message]) {
      expect(notice.copyText).toContain(value);
    }
  });

  it("keeps an available thread reference and every worktree path visible and copyable", () => {
    fc.assert(fc.property(fc.uuid(), fc.array(fc.uuid(), { minLength: 1, maxLength: 3 }), (threadId, paths) => {
      const signal = {
        kind: "archive-thread" as const,
        message: "Federation peer fixture-peer is not connected.",
        threadLink: { backend: "codex" as const, instanceId: "fixture-peer", threadId, title: "Repair build caching" },
        worktreePaths: paths.map((path) => `/contrived/worktrees/${path}`),
      };
      const notice = resolveThreadActionErrorNotice(signal);
      const container = document.createElement("div");
      container.innerHTML = renderToStaticMarkup(<AppNoticeToast notice={notice} onDismiss={() => undefined} onOpenThread={() => undefined} />);
      expect(container.querySelector(".thread-chip")?.textContent).toContain(signal.threadLink.title);
      for (const value of [threadId, ...signal.worktreePaths]) {
        expect(container.textContent).toContain(value);
        expect(notice.copyText).toContain(value);
      }
      expect(notice.threadLink).toEqual(signal.threadLink);
      expect(notice.copyText).toContain(signal.threadLink.title);
      expect(notice.copyText).toContain(signal.threadLink.instanceId);
      expect(notice.copyText).toContain(signal.message);
    }));
  });

  // The peer directory owns the name. Across IPC wrappers and peer ids, the
  // operator sees that peer's short name in a chip, and Copy keeps diagnostics.
  it("uses the directory's short name instead of raw transport diagnostics", () => {
    fc.assert(fc.property(
      fc.uuid(),
      fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,11}$/),
      fc.constantFrom("", "FederationPeerUnavailableError: ", "Error invoking remote method 'app-server:archive-thread': FederationPeerUnavailableError: "),
      fc.constantFrom("is not connected.", "disconnected."),
      (uuid, shortLabel, prefix, reason) => {
        const instanceId = `pwr_${uuid}`;
        const message = `${prefix}Federation peer ${instanceId} ${reason}`;
        const rendered = renderNotice(message, peerHealth(instanceId, shortLabel));
        expect(rendered.querySelector(".chip--instance__label")?.textContent).toBe(shortLabel);
        expect(rendered.textContent).toContain("is not connected.");
        expect(rendered.textContent).not.toContain(instanceId);
        expect(rendered.textContent).not.toContain("FederationPeerUnavailableError");
        expect(rendered.textContent).not.toContain("Error invoking remote method");
        expect(resolveThreadActionErrorNotice({ kind: "archive-thread", message }).copyText).toBe(message);
      },
    ));
  });

  it("names the disconnected archive peer in a chip", () => {
    const instanceId = "pwr_00000000-0000-4000-8000-000000000001";
    const message = `Error invoking remote method 'app-server:archive-thread': FederationPeerUnavailableError: Federation peer ${instanceId} is not connected.`;
    const rendered = renderNotice(message, peerHealth(instanceId, "Studio"));
    expect(rendered.querySelector(".chip--instance__label")?.textContent).toBe("Studio");
    expect(rendered.querySelector(".chip--instance")?.getAttribute("title"))
      .toBe(`Showcase-Mac-Studio · ${instanceId}`);
  });

  it("keeps a one-character short name", () => {
    const instanceId = "pwr_00000000-0000-1000-8000-000000000000";
    const rendered = renderNotice(`Federation peer ${instanceId} is not connected.`, peerHealth(instanceId, "a"));
    expect(rendered.querySelector(".chip--instance__label")?.textContent).toBe("a");
  });

  it("falls back to the full name, then a readable unknown peer", () => {
    const message = "Federation peer missing-peer is not connected.";
    expect(renderNotice(message, peerHealth("missing-peer")).textContent).toContain("Showcase-Mac-Studio");
    expect(renderNotice(message).textContent).toContain("Unknown peer");
    expect(renderNotice(message).textContent).not.toContain("missing-peer");
  });

  it("preserves unrelated errors even when they quote an offline error", () => {
    const message = "Archive failed while handling: Federation peer missing-peer is not connected.";
    const rendered = renderNotice(message);
    expect(rendered.textContent).toBe(message);
    expect(rendered.querySelector(".chip--instance")).toBeNull();
  });
});
