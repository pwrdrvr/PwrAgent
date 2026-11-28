import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../../lib/desktop-api";
import { ProfileRowLoginStatus, useCodexProfileLogin } from "../CodexLoginRow";

afterEach(cleanup);

type StatusResult = { authenticated: boolean; email?: string; detail?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("Codex profile sign-in state", () => {
  it("says not signed in, not that a browser opened, when a check finds no sign-in", async () => {
    const desktopApi = {
      checkCodexAuthProfileStatus: vi.fn(async (): Promise<StatusResult> => ({ authenticated: false })),
    } as unknown as DesktopApi;
    const { result } = renderHook(() => useCodexProfileLogin(desktopApi, ""));

    await act(async () => { await result.current.check(); });

    expect(result.current.state.kind).toBe("signed-out");
    render(<ProfileRowLoginStatus state={result.current.state} />);
    expect(screen.queryByText(/Browser opened/)).not.toBeInTheDocument();
    expect(screen.getByText(/Not signed in/)).toBeInTheDocument();
  });

  it("keeps waiting for the browser when the check follows a sign-in it started", async () => {
    const desktopApi = {
      startCodexAuthProfileLogin: vi.fn(async () => ({
        authenticated: false,
        loginUrl: "https://auth.example.com/login",
      })),
      checkCodexAuthProfileStatus: vi.fn(async (): Promise<StatusResult> => ({ authenticated: false })),
    } as unknown as DesktopApi;
    const { result } = renderHook(() => useCodexProfileLogin(desktopApi, ""));

    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.check(); });

    expect(result.current.state).toMatchObject({ kind: "waiting", url: "https://auth.example.com/login" });
  });

  it("does not carry one profile's sign-in over to the next", async () => {
    const desktopApi = {
      checkCodexAuthProfileStatus: vi.fn(async (): Promise<StatusResult> => ({
        authenticated: true,
        email: "someone@example.com",
      })),
    } as unknown as DesktopApi;
    const { result, rerender } = renderHook(
      ({ profile }) => useCodexProfileLogin(desktopApi, profile),
      { initialProps: { profile: "" } },
    );
    await act(async () => { await result.current.check(); });
    expect(result.current.state.kind).toBe("ok");

    rerender({ profile: "work" });

    expect(result.current.state.kind).toBe("idle");
  });

  it("drops a check that answers after the operator switched profiles", async () => {
    const answer = deferred<StatusResult>();
    const desktopApi = {
      checkCodexAuthProfileStatus: vi.fn(() => answer.promise),
    } as unknown as DesktopApi;
    const { result, rerender } = renderHook(
      ({ profile }) => useCodexProfileLogin(desktopApi, profile),
      { initialProps: { profile: "" } },
    );
    let pending!: Promise<void>;
    act(() => { pending = result.current.check(); });
    expect(result.current.state.kind).toBe("checking");

    rerender({ profile: "work" });
    await act(async () => {
      answer.resolve({ authenticated: true, email: "someone@example.com" });
      await pending;
    });

    // The answer was about the system default profile, not "work".
    expect(result.current.state.kind).toBe("idle");
  });
});
