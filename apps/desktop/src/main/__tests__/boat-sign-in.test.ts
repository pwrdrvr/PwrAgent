import { describe, expect, it, vi } from "vitest";
import { BOAT_KEY_ARGS, BoatSignIn, type BoatCliRun } from "../mcp-connections/boat-sign-in";

/**
 * Boat's browser sign-in, against a fake CLI. The rules: only Boat's own
 * page is opened, the key goes to the store and nowhere else, the session
 * the CLI opened is revoked, and the throwaway home never outlives the
 * attempt, however it ends.
 */

// Contrived: shaped like a Boat key and a Boat code, issued by nobody.
const KEY = "boat_live_DADAMAMA0123456789abcdef";
const CODE = "DADA-MAMA";
const NOW = 1_000_000;

function loginLine(patch: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    event: "login_url",
    url: "https://boat.dev/api/boat/auth/github?state=contrived",
    userCode: CODE,
    expiresAt: new Date(NOW + 60_000).toISOString(),
    pollToken: "contrived-poll-token",
    ...patch,
  })}\n`;
}

function harness(script: {
  login?: () => Promise<string>;
  wait?: (signal?: AbortSignal) => Promise<string>;
  create?: () => Promise<string>;
  storeKey?: (key: string) => Promise<void>;
  cli?: string | undefined;
} = {}) {
  const calls: Array<{ args: string[]; home: string }> = [];
  const homes: string[] = [];
  const removed: string[] = [];
  const opened: string[] = [];
  const stored: string[] = [];
  let settled!: () => void;
  const idle = new Promise<void>((resolve) => { settled = resolve; });
  const changes: Array<ReturnType<BoatSignIn["progress"]>> = [];
  const run: BoatCliRun = async (_cli, args, options) => {
    calls.push({ args: [...args], home: options.home });
    if (args[0] === "login" && args.includes("--wait")) {
      return await (script.wait ?? (async () => "{}"))(options.signal);
    }
    if (args[0] === "login") return await (script.login ?? (async () => loginLine()))();
    if (args[0] === "api-key") {
      return await (script.create ?? (async () => JSON.stringify({ ok: true, apiKey: { id: "key_1", prefix: "boat_live", secret: KEY } })))();
    }
    return "";
  };
  const signIn: BoatSignIn = new BoatSignIn({
    run,
    findCli: async () => ("cli" in script ? script.cli : "/contrived/bin/boat"),
    makeHome: async () => {
      const home = `/contrived/home-${homes.length}`;
      homes.push(home);
      return home;
    },
    removeHome: async (home) => {
      removed.push(home);
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    storeKey: script.storeKey ?? (async (key) => {
      stored.push(key);
    }),
    onChanged: () => {
      changes.push(signIn.progress());
      // The attempt is over once its home is gone.
      if (homes.length > 0 && homes.every((home) => removed.includes(home))) settled();
    },
    now: () => NOW,
  });
  return { calls, changes, homes, idle, opened, removed, signIn, stored };
}

describe("BoatSignIn", () => {
  it("shows the code, stores the minted key, revokes the session and deletes the home", async () => {
    const h = harness();
    const progress = await h.signIn.start("github");
    expect(progress).toEqual({ state: "waiting", method: "github", userCode: CODE, expiresAt: NOW + 60_000 });
    expect(h.opened).toEqual(["https://boat.dev/api/boat/auth/github?state=contrived"]);
    await h.idle;

    expect(h.stored).toEqual([KEY]);
    expect(h.calls.map((call) => call.args)).toEqual([
      ["login", "--json"],
      ["login", "--wait", "--json"],
      [...BOAT_KEY_ARGS],
      ["logout"],
    ]);
    // Every step ran in the one throwaway home, which is gone.
    expect(new Set(h.calls.map((call) => call.home))).toEqual(new Set(h.homes));
    expect(new Set(h.removed)).toEqual(new Set(h.homes));
    expect(h.signIn.progress()).toBeUndefined();
    // Nothing a window is told carries the key.
    expect(JSON.stringify([progress, h.changes])).not.toContain(KEY);
  });

  it("asks for Google sign-in when that is chosen", async () => {
    const h = harness();
    await h.signIn.start("google");
    expect(h.calls[0]?.args).toEqual(["login", "--json", "--google"]);
    await h.idle;
  });

  it.each([
    ["another site", { url: "https://boat.dev.example.test/auth" }],
    ["a non-HTTPS page", { url: "http://boat.dev/auth" }],
    ["no link at all", { url: undefined }],
  ])("opens nothing when the CLI answers %s", async (_name, patch) => {
    const h = harness({ login: async () => loginLine(patch) });
    await expect(h.signIn.start("github")).rejects.toThrow();
    expect(h.opened).toEqual([]);
    expect(h.removed).toEqual(h.homes);
    expect(h.signIn.progress()).toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });

  it("reports a sign-in nobody finished, stores nothing, and has no session to revoke", async () => {
    const h = harness({ wait: async () => { throw new Error("sign-in link expired"); } });
    await h.signIn.start("github");
    await h.idle;
    expect(h.signIn.progress()).toEqual({ state: "failed", error: "sign-in link expired" });
    expect(h.stored).toEqual([]);
    expect(h.calls.some((call) => call.args[0] === "logout")).toBe(false);
    expect(h.removed).toEqual(h.homes);
  });

  it.each([
    ["Boat will not create a key", { create: async () => { throw new Error("plan required"); } }, "plan required"],
    ["the CLI answers no key", { create: async () => "{\"ok\":true}" }, "Boat signed in but returned no API key."],
    ["the key cannot be stored", {
      storeKey: async () => { throw new Error(`could not store ${KEY}`); },
    }, "could not store [Boat key removed]"],
  ])("still revokes the session and deletes the home when %s", async (_name, script, error) => {
    const h = harness(script);
    await h.signIn.start("github");
    await h.idle;
    expect(h.signIn.progress()).toEqual({ state: "failed", error });
    expect(h.calls.at(-1)?.args).toEqual(["logout"]);
    expect(h.removed).toEqual(h.homes);
    expect(JSON.stringify(h.changes)).not.toContain(KEY);
  });

  it("stops waiting on cancel, stores nothing, and deletes the home", async () => {
    const h = harness({
      wait: async (signal) => await new Promise<string>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    });
    await h.signIn.start("github");
    await h.signIn.cancel();
    await h.idle;
    // The aborted wait unwinds on its own; it must not report a failure.
    await vi.waitFor(() => expect(h.removed.length).toBeGreaterThanOrEqual(2));
    expect(h.signIn.progress()).toBeUndefined();
    expect(h.stored).toEqual([]);
    expect(h.removed).toContain(h.homes[0]);
    expect(h.calls.some((call) => call.args[0] === "api-key")).toBe(false);
  });

  it("stores nothing when sign-in is cancelled while the key is being created", async () => {
    const holder: { signIn?: BoatSignIn } = {};
    const h = harness({
      create: async () => {
        await holder.signIn!.cancel();
        return JSON.stringify({ secret: KEY });
      },
    });
    holder.signIn = h.signIn;
    await h.signIn.start("github");
    await vi.waitFor(() => expect(h.calls.at(-1)?.args).toEqual(["logout"]));
    expect(h.stored).toEqual([]);
    expect(h.signIn.progress()).toBeUndefined();
  });

  it("refuses to start without Boat's CLI, and makes no home", async () => {
    const h = harness({ cli: undefined });
    expect(await h.signIn.cliAvailable()).toBe(false);
    await expect(h.signIn.start("github")).rejects.toThrow("not installed");
    expect(h.homes).toEqual([]);
  });

  it("replaces an attempt in flight with the new one", async () => {
    const gate = vi.fn(async (signal?: AbortSignal) => await new Promise<string>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      if (gate.mock.calls.length > 1) resolve("{}");
    }));
    const h = harness({ wait: gate });
    await h.signIn.start("github");
    await h.signIn.start("google");
    await vi.waitFor(() => expect(h.stored).toEqual([KEY]));
    await vi.waitFor(() => expect(new Set(h.removed)).toEqual(new Set(h.homes)));
    expect(h.homes).toHaveLength(2);
    expect(h.signIn.progress()).toBeUndefined();
  });
});
