import type { NavigationQueryRequest } from "@pwragent/shared";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createNavigationPageState } from "../../../lib/navigation-query-state";
import type { NavigationWindowResource } from "../../../lib/navigation-window-queries";
import {
  NAVIGATION_READ_ERROR_NOTICE_IDS,
  resolveNavigationReadErrorNotices,
  useNavigationReadErrorNotices,
} from "../navigation-read-error-notice";

describe("navigation read error notices", () => {
  it("raises one durable toast per kind and none for an offline peer", () => {
    const failed = "Error invoking remote method 'navigation:get-query-page': Error: owner exploded";
    const notices = resolveNavigationReadErrorNotices({
      pageErrors: [
        undefined,
        "Federation peer peer-1 is not connected.",
        "Navigation retained-page budget reached. Collapse a directory or change lens to release pages.",
        "Navigation retained-page budget reached. Collapse a directory or change lens to release pages.",
        failed,
        "Error: a second failure",
      ].map((error) => ({ error })),
    });

    expect(notices.map((notice) => [notice.id, notice.title, notice.autoDismiss, notice.tone])).toEqual([
      ["navigation-read-error:page-budget", "Too many thread lists open", false, "error"],
      ["navigation-read-error:read-failed", "Couldn't load threads", false, "error"],
    ]);
    // Distinct failures stay copyable without duplicating the toast.
    expect(notices[1]?.copyText).toBe(`${failed}\n\nError: a second failure`);
    expect(notices[1]?.message).not.toContain("navigation:get-query-page");
  });

  it("reports the window's demand budget as the page budget", () => {
    const admissionError = "Navigation request metadata exceeds its memory budget.";
    expect(resolveNavigationReadErrorNotices({ admissionError, pageErrors: [] })).toEqual([
      expect.objectContaining({ id: "navigation-read-error:page-budget", copyText: admissionError }),
    ]);
  });

  it("says nothing when every read is healthy or only a peer is offline", () => {
    expect(resolveNavigationReadErrorNotices({
      pageErrors: [undefined, "Target federation peer is not connected."].map((error) => ({ error })),
    })).toEqual([]);
  });

  it("lists every id it can raise, so App can take each down", () => {
    expect(NAVIGATION_READ_ERROR_NOTICE_IDS).toEqual([
      "navigation-read-error:page-budget",
      "navigation-read-error:owner-upgrade",
      "navigation-read-error:viewer-upgrade",
      "navigation-read-error:read-failed",
    ]);
  });

  it("shows a failure once, holds it through a re-read, and takes it down on recovery", () => {
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" } };
    const resource = (error: string | undefined, loading = false): NavigationWindowResource => ({
      id: "lens", loading, state: { ...createNavigationPageState(request), error },
    });
    const dispatch = vi.fn();
    type Props = { resources: ReadonlyMap<string, NavigationWindowResource> };
    const { rerender } = renderHook(
      ({ resources }: Props) => useNavigationReadErrorNotices({ resources }, dispatch),
      { initialProps: { resources: new Map([["lens", resource("Error: owner exploded")]]) } as Props },
    );
    const shown = dispatch.mock.calls.filter(([action]) => action.type === "show");
    expect(shown.map(([action]) => action.notice.id)).toEqual(["navigation-read-error:read-failed"]);

    // A refresh clears the error while it reads (beginNavigationPageRead), then
    // fails the same way. The operator may have dismissed the toast meanwhile.
    dispatch.mockClear();
    rerender({ resources: new Map([["lens", resource(undefined, true)]]) });
    rerender({ resources: new Map([["lens", resource("Error: owner exploded")]]) });
    expect(dispatch).not.toHaveBeenCalled();

    rerender({ resources: new Map([["lens", resource(undefined)]]) });
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual(
      NAVIGATION_READ_ERROR_NOTICE_IDS.map((id) => ({ type: "dismiss", id })),
    );
  });

  it("raises no toast for an offline peer", () => {
    const request: NavigationQueryRequest = { protocol: 2, consumer: "main-sidebar", query: { kind: "exact", identities: [] } };
    const dispatch = vi.fn();
    renderHook(() => useNavigationReadErrorNotices({ resources: new Map([["drafts:peer", {
      id: "drafts:peer", loading: false,
      state: { ...createNavigationPageState(request), error: "Federation peer peer-1 is not connected." },
    }]]) }, dispatch));
    expect(dispatch.mock.calls.filter(([action]) => action.type === "show")).toEqual([]);
  });
});

const busy = "handler_failed: [navigation_busy] Navigation read cancelled or its deadline expired.";
const peerResource = (instanceId: string, error: string | undefined = busy, loading = false): NavigationWindowResource => ({
  id: instanceId, loading, state: { ...createNavigationPageState({ protocol: 2, consumer: "main-sidebar",
    federationTarget: { scope: "remote", instanceId }, query: { kind: "exact", identities: [] } }), error },
});

it("names the single delayed federation instance and includes its identity in copied diagnostics", () => {
  const dispatch = vi.fn();
  renderHook(() => useNavigationReadErrorNotices({
    resources: new Map([["failed", peerResource("windows-dev")], ["healthy", peerResource("studio", "", true)]]),
    instances: [{ instanceId: "windows-dev", label: "Windows / dev" }, { instanceId: "studio", label: "Studio" }],
  }, dispatch));
  const notice = dispatch.mock.calls.find(([action]) => action.type === "show")?.[0].notice;
  expect(notice).toMatchObject({ title: "Thread loading delayed",
    message: "Thread lists from this federation instance are busy or taking too long to load.",
    facts: [{ label: "Federation instance", value: "Windows / dev" }] });
  expect(notice.copyText).toContain("Windows / dev (windows-dev)");
  expect(notice.copyText).toContain(busy);
  expect(notice.copyText).not.toContain("Studio");
});

it("names every affected instance once while distinguishing local failures", () => {
  const dispatch = vi.fn();
  const local = peerResource("local");
  local.state.request.federationTarget = undefined;
  renderHook(() => useNavigationReadErrorNotices({ resources: new Map([
    ["peer-a", peerResource("a")], ["peer-a-more", peerResource("a")], ["peer-b", peerResource("b")], ["local", local],
  ]), instances: [{ instanceId: "a", label: "Windows / dev" }, { instanceId: "b", label: "Studio" }] }, dispatch));
  const notices = dispatch.mock.calls.filter(([action]) => action.type === "show").map(([action]) => action.notice);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ title: "Thread loading delayed", facts: [
    { label: "Instance", value: "This instance" },
    { label: "Federation instances", value: "Windows / dev, Studio" },
  ] });
});

it("falls back to an unknown owner's instance ID without describing arbitrary failures as slow", () => {
  const dispatch = vi.fn();
  renderHook(() => useNavigationReadErrorNotices({
    resources: new Map([["failed", peerResource("unknown-peer", "owner exploded")]]),
  }, dispatch));
  expect(dispatch.mock.calls.find(([action]) => action.type === "show")?.[0].notice).toMatchObject({
    title: "Couldn't load threads", message: "Thread lists from this federation instance couldn't be loaded.",
    facts: [{ label: "Federation instance", value: "unknown-peer" }],
  });
});

it("retains attribution through refresh and removes recovered owners from the notice", () => {
  const dispatch = vi.fn();
  const instances = [{ instanceId: "a", label: "Windows / dev" }, { instanceId: "b", label: "Studio" }];
  type Props = { resources: ReadonlyMap<string, NavigationWindowResource> };
  const { rerender } = renderHook(({ resources }: Props) => useNavigationReadErrorNotices({ resources, instances }, dispatch), {
    initialProps: { resources: new Map([["a", peerResource("a")], ["b", peerResource("b")]]) } as Props,
  });
  dispatch.mockClear();
  const reading = peerResource("a");
  reading.state.error = undefined;
  reading.loading = true;
  rerender({ resources: new Map([["a", reading], ["b", peerResource("b")]]) });
  expect(dispatch).not.toHaveBeenCalled();
  rerender({ resources: new Map([["a", { ...reading, loading: false }], ["b", peerResource("b")]]) });
  const notice = dispatch.mock.calls.find(([action]) => action.type === "show")?.[0].notice;
  expect(notice.facts).toEqual([{ label: "Federation instance", value: "Studio" }]);
  expect(notice.copyText).not.toContain("Windows / dev");
});

it("preserves distinct diagnostics from one owner without labeling every failure as contention", () => {
  const [notice] = resolveNavigationReadErrorNotices({ pageErrors: [
    { instanceId: "a", error: busy }, { instanceId: "a", error: "Invalid owner response" },
    { instanceId: "a", error: busy },
  ], instances: [{ instanceId: "a", label: "Windows / dev" }] });
  expect(notice).toMatchObject({ title: "Couldn't load threads", facts: [{ label: "Federation instance", value: "Windows / dev" }] });
  expect(notice?.copyText?.split(busy)).toHaveLength(2);
  expect(notice?.copyText).toContain("Invalid owner response");
});

it("does not attribute a previous owner's in-flight error to a replacement owner", () => {
  const dispatch = vi.fn();
  type Props = { resources: ReadonlyMap<string, NavigationWindowResource> };
  const { rerender } = renderHook(({ resources }: Props) => useNavigationReadErrorNotices({ resources }, dispatch), {
    initialProps: { resources: new Map([["selection", peerResource("a")]]) } as Props,
  });
  dispatch.mockClear();
  const replacement = peerResource("b", "", true);
  rerender({ resources: new Map([["selection", replacement]]) });
  expect(dispatch.mock.calls.some(([action]) => action.type === "show")).toBe(false);
  expect(dispatch.mock.calls.map(([action]) => action)).toContainEqual({ type: "dismiss", id: "navigation-read-error:read-failed" });
});
