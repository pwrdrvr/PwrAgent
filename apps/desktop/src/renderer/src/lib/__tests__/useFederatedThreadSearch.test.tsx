// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FederationJumpSearchRequest, FederationJumpSearchResponse } from "@pwragent/shared";
import { FEDERATED_THREAD_SEARCH_DEBOUNCE_MS, useFederatedThreadSearch } from "../useFederatedThreadSearch";

vi.mock("../federation-window", () => ({ readRendererFederationTarget: () => undefined }));
vi.mock("../desktop-api", () => ({ getDesktopApi: () => undefined }));
afterEach(() => vi.useRealTimers());

describe("federated search scheduling", () => {
  it("debounces typing and coalesces in-flight changes to only the latest query", async () => {
    vi.useFakeTimers();
    let finish!: (value: FederationJumpSearchResponse) => void;
    const search = vi.fn((_request: FederationJumpSearchRequest) => new Promise<FederationJumpSearchResponse>((resolve) => { finish = resolve; }));
    const hook = renderHook(({ query }) => useFederatedThreadSearch({ query, search }), { initialProps: { query: "19" } });
    hook.rerender({ query: "196" });
    await act(async () => { await vi.advanceTimersByTimeAsync(FEDERATED_THREAD_SEARCH_DEBOUNCE_MS); });
    expect(search).toHaveBeenCalledTimes(1);
    hook.rerender({ query: "1967" });
    await act(async () => { await vi.advanceTimersByTimeAsync(FEDERATED_THREAD_SEARCH_DEBOUNCE_MS); });
    hook.rerender({ query: "1968" });
    await act(async () => { await vi.advanceTimersByTimeAsync(FEDERATED_THREAD_SEARCH_DEBOUNCE_MS); });
    expect(search).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ results: [] }); });
    expect(search).toHaveBeenCalledTimes(2);
    expect(search.mock.calls.at(-1)?.[0]).toMatchObject({ query: "1968" });
    hook.unmount();
  });

  it("does not dispatch a queued query after the palette unmounts", async () => {
    vi.useFakeTimers();
    let finish!: (value: FederationJumpSearchResponse) => void;
    const search = vi.fn((_request: FederationJumpSearchRequest) => new Promise<FederationJumpSearchResponse>((resolve) => { finish = resolve; }));
    const hook = renderHook(({ query }) => useFederatedThreadSearch({ query, search }), { initialProps: { query: "196" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(FEDERATED_THREAD_SEARCH_DEBOUNCE_MS); });
    hook.rerender({ query: "1968" });
    await act(async () => { await vi.advanceTimersByTimeAsync(FEDERATED_THREAD_SEARCH_DEBOUNCE_MS); });
    hook.unmount();
    await act(async () => { finish({ results: [] }); });
    expect(search).toHaveBeenCalledTimes(1);
  });
});
