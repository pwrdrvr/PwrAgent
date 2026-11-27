import { renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import type { NavigationIdentity, NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { DesktopApi } from "../desktop-api";
import type { NavigationSelectionState } from "../navigation-query-state";
import { useComposerConfigurationPreview } from "../useComposerConfigurationPreview";

it("revokes the owning thread's preview even when its sidebar row has left the page", () => {
  const api: DesktopApi = {};
  const local: NavigationIdentity = { backend: "codex", threadId: "shared-id" };
  const peer = { ...local, ownerInstanceId: "peer" };
  const row: NavigationThreadSummary = { source: local.backend, id: local.threadId, title: "Local",
    titleSource: "explicit", inbox: { inInbox: true }, linkedDirectories: [] };
  const peerRow: NavigationThreadSummary = { ...row, federation: { instanceLabel: "Peer",
    ref: { ...local, target: { scope: "remote", instanceId: "peer" } } } };
  function confirmed(ref: NavigationIdentity, thread: NavigationThreadSummary): NavigationSelectionState {
    return {
      ref, readiness: "ready", pendingSequence: 1,
      detail: {
        protocol: 2, ref, readiness: "ready", identity: "present", revision: "initial",
        thread: {
          ...thread,
          codexEnvironmentRuntime: { executionTarget: "local", environmentId: thread.federation ? "remote" : "local" },
        },
      },
    };
  }

  type Props = { ref: NavigationIdentity; selection?: NavigationSelectionState; selectedRow?: NavigationThreadSummary };
  const initialProps: Props = { ref: local, selection: confirmed(local, row), selectedRow: row };
  const { result, rerender } = renderHook(({ ref, selection, selectedRow }: Props) =>
    useComposerConfigurationPreview(api, ref, selection, selectedRow), { initialProps });
  rerender({ ref: peer, selectedRow: peerRow });
  expect(result.current).toBeUndefined();
  rerender({ ref: peer, selection: confirmed(peer, peerRow), selectedRow: peerRow });
  rerender({ ref: peer, selectedRow: peerRow });
  expect(result.current?.codexEnvironmentRuntime?.environmentId).toBe("remote");
  rerender({ ref: peer, selection: { ref: peer, pendingSequence: 2, readiness: "failed" } });
  rerender({ ref: peer, selectedRow: peerRow });
  expect(result.current).toBeUndefined();
  rerender({ ref: local, selectedRow: row });
  expect(result.current?.codexEnvironmentRuntime?.environmentId).toBe("local");
});
