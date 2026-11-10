import fc from "fast-check";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { FederationHealthStatus } from "@pwragent/shared";
import { FederationDisplayLabelsProvider } from "../../../lib/federation-display-label";
import { AppNoticeToast } from "../AppNoticeToast";
import { resolveThreadActionErrorNotice } from "../thread-action-error-notice";

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
