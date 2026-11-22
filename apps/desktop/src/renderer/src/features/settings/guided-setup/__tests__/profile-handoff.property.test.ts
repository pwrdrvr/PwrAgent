import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  POST_ALIVE_GRACE_MS,
  openCreatedProfile,
  type ProfileHandoffApi,
} from "../profile-handoff";

type AliveBehavior = "alive" | "not-alive" | "throws" | "missing";

function makeApi(params: {
  alive: AliveBehavior;
  openThrows: boolean;
}) {
  const calls: string[] = [];
  const api: ProfileHandoffApi = {
    openPwrAgentProfile: vi.fn(async () => {
      calls.push("open");
      if (params.openThrows) throw new Error("spawn failed");
      return undefined as never;
    }),
    quitApp: vi.fn(async () => {
      calls.push("quit");
    }),
    shutdownMessagingRuntime: vi.fn(async () => {
      calls.push("shutdown-messaging");
    }),
    ...(params.alive === "missing"
      ? {}
      : {
          waitForProfileAlive: vi.fn(async () => {
            calls.push("wait");
            if (params.alive === "throws") throw new Error("no marker");
            return { alive: params.alive === "alive" } as never;
          }),
        }),
  };
  return { api, calls };
}

describe("opening a created profile", () => {
  it("quits the bootstrap window only after the new one reports ready", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<AliveBehavior>("alive", "not-alive", "throws", "missing"),
        fc.boolean(),
        async (alive, openThrows) => {
          const { api, calls } = makeApi({ alive, openThrows });
          const sleep = vi.fn(async () => undefined);
          const outcome = await openCreatedProfile({
            api,
            profile: "work",
            bootMode: "bootstrap",
            isDev: false,
            sleep,
            warn: () => undefined,
          });
          // The bootstrap window is the fallback: it stays unless the new
          // window opened and nothing said it failed to come up.
          const shouldQuit = !openThrows && (alive === "alive" || alive === "missing");
          expect(calls.includes("quit")).toBe(shouldQuit);
          if (shouldQuit) {
            expect(outcome.kind).toBe("handed-off");
            expect(sleep).toHaveBeenCalledWith(POST_ALIVE_GRACE_MS);
            expect(calls.indexOf("open")).toBeLessThan(calls.indexOf("quit"));
          } else if (openThrows) {
            expect(outcome.kind).toBe("open-failed");
          } else {
            expect(outcome.kind).toBe("kept-bootstrap");
          }
          // Adapters are released before the new instance starts.
          expect(calls[0]).toBe("shutdown-messaging");
        },
      ),
    );
  });

  it("never quits or stops messaging in an active profile", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<AliveBehavior>("alive", "not-alive", "throws", "missing"),
        fc.boolean(),
        fc.boolean(),
        async (alive, openThrows, isDev) => {
          const { api, calls } = makeApi({ alive, openThrows });
          const outcome = await openCreatedProfile({
            api,
            profile: "work",
            bootMode: "active-profile",
            isDev,
            sleep: async () => undefined,
            warn: () => undefined,
          });
          expect(calls).not.toContain("quit");
          expect(calls).not.toContain("shutdown-messaging");
          expect(calls).toContain("open");
          expect(outcome.kind).toBe(openThrows ? "open-failed" : "opened");
        },
      ),
    );
  });

  it("reports when this build can't open another profile", async () => {
    expect(
      await openCreatedProfile({
        api: {},
        profile: "work",
        bootMode: "active-profile",
        isDev: false,
      }),
    ).toEqual({ kind: "unavailable" });
  });
});
