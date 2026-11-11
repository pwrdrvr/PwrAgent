import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_PWRSNAP_MEDIA_LINKS_PER_SESSION,
  PwrSnapMediaLinks,
} from "../mcp-connections/pwrsnap-media-links";

vi.mock("electron", () => ({
  protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

/**
 * The rule: a transcript image link is read only through the live PwrSnap
 * session that returned it, for the thread it was returned to. Sessions are
 * pooled, so one thread's calls run on several sessions and several threads
 * share each. Links the model wrote, another MCP server returned, an ended
 * session returned, or a thread whose grant ended received are never read.
 */

/** Bridge tokens, one per thread and connection, as the gateway issues them. */
const TOKENS = {
  snapA: { connectionId: "pwrsnap", threadId: "thread-a" },
  // The `call_mcp_tool` path has its own grant on the same thread.
  snapA2: { connectionId: "pwrsnap", threadId: "thread-a" },
  snapB: { connectionId: "pwrsnap", threadId: "thread-b" },
  otherA: { connectionId: "other-server", threadId: "thread-a" },
} as const;
type Token = keyof typeof TOKENS;
const TOKEN_NAMES = Object.keys(TOKENS) as Token[];
const THREADS = ["thread-a", "thread-b", "thread-c"];
const URIS = [
  "pwrsnap://capture/c0/composite",
  "pwrsnap://capture/c1/original",
  "pwrsnap://capture/c2/composite",
  "https://example.com/c0.png",
];
const SESSION_SLOTS = 3;

const blockArb = fc.record({
  type: fc.constantFrom("resource_link", "image", "text"),
  uri: fc.constantFrom(...URIS),
  mimeType: fc.constantFrom("image/png", "IMAGE/JPEG", "video/mp4", undefined),
});

type Command =
  | { kind: "open"; slot: number }
  | { kind: "die"; slot: number }
  | { kind: "grant"; token: Token }
  | { kind: "revoke"; token: Token }
  | { kind: "result"; token: Token; slot: number; blocks: Array<{ type: string; uri: string; mimeType?: string }> }
  | { kind: "query"; threadId: string; uri: string };

const tokenArb = fc.constantFrom(...TOKEN_NAMES);
const slotArb = fc.integer({ min: 0, max: SESSION_SLOTS - 1 });
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  // A pooled session opens in a slot, replacing whatever died there.
  fc.record({ kind: fc.constant("open" as const), slot: slotArb }),
  fc.record({ kind: fc.constant("die" as const), slot: slotArb }),
  fc.record({ kind: fc.constant("grant" as const), token: tokenArb }),
  fc.record({ kind: fc.constant("revoke" as const), token: tokenArb }),
  fc.record({ kind: fc.constant("result" as const), token: tokenArb, slot: slotArb, blocks: fc.array(blockArb, { maxLength: 4 }) }),
  fc.record({ kind: fc.constant("query" as const), threadId: fc.constantFrom(...THREADS), uri: fc.constantFrom(...URIS) }),
);

describe("PwrSnap media links", () => {
  it("answers only through the live session that returned the link to that thread", () => {
    fc.assert(fc.property(fc.array(commandArb, { maxLength: 80 }), (commands) => {
      const links = new PwrSnapMediaLinks();
      const slots: Array<object | undefined> = Array.from({ length: SESSION_SLOTS }, () => undefined);
      const granted = new Set<Token>(TOKEN_NAMES);
      // Model: what each session returned on each token while both were live.
      const returned = new Map<Token, Map<object, Set<string>>>();
      const live = (session: object): boolean => slots.includes(session);
      const lookup = {
        isLive: (token: string, session: object) => granted.has(token as Token) && live(session),
        threadOf: (token: string) => TOKENS[token as Token]?.threadId,
      };

      for (const command of commands) {
        switch (command.kind) {
          case "open": {
            const old = slots[command.slot];
            if (old) links.forgetSession(old);
            slots[command.slot] = {};
            break;
          }
          case "die": {
            const old = slots[command.slot];
            slots[command.slot] = undefined;
            // The gateway learns of a death later; an unforgotten session
            // still must not answer, because it is no longer live.
            if (old && command.slot % 2 === 0) links.forgetSession(old);
            break;
          }
          case "grant":
            granted.add(command.token);
            break;
          case "revoke":
            granted.delete(command.token);
            links.forget(command.token);
            returned.delete(command.token);
            break;
          case "result": {
            const session = slots[command.slot];
            if (!session || !granted.has(command.token)) break;
            links.record(command.token, TOKENS[command.token].connectionId, session, { content: command.blocks });
            if (TOKENS[command.token].connectionId !== "pwrsnap") break;
            for (const block of command.blocks) {
              if (
                block.type === "resource_link"
                && block.mimeType?.toLowerCase().startsWith("image/")
                && block.uri.startsWith("pwrsnap://")
              ) {
                let bySession = returned.get(command.token);
                if (!bySession) returned.set(command.token, bySession = new Map());
                let uris = bySession.get(session);
                if (!uris) bySession.set(session, uris = new Set());
                uris.add(block.uri);
              }
            }
            break;
          }
          case "query": {
            const allowed: Array<{ token: Token; session: object }> = [];
            for (const token of TOKEN_NAMES) {
              if (TOKENS[token].threadId !== command.threadId || !granted.has(token)) continue;
              for (const [session, uris] of returned.get(token) ?? []) {
                if (live(session) && uris.has(command.uri)) allowed.push({ token, session });
              }
            }
            const answer = links.resolve(command.threadId, command.uri, lookup);
            if (allowed.length === 0) {
              expect(answer).toBeUndefined();
            } else {
              // Sessions are compared by identity: every one is an empty object.
              expect(allowed.some((pair) => pair.token === answer?.token && pair.session === answer?.session)).toBe(true);
            }
          }
        }
      }
    }), { numRuns: 500 });
  });

  it("forgets a session's oldest links past its limit", () => {
    const links = new PwrSnapMediaLinks();
    const session = {};
    const lookup = { isLive: () => true, threadOf: () => "thread-a" };
    for (let index = 0; index <= MAX_PWRSNAP_MEDIA_LINKS_PER_SESSION; index += 1) {
      links.record("snapA", "pwrsnap", session, {
        content: [{ type: "resource_link", uri: `pwrsnap://capture/c${index}/composite`, mimeType: "image/png" }],
      });
    }
    expect(links.resolve("thread-a", "pwrsnap://capture/c0/composite", lookup)).toBeUndefined();
    const answer = links.resolve("thread-a", "pwrsnap://capture/c1/composite", lookup);
    expect(answer?.token).toBe("snapA");
    expect(answer?.session).toBe(session);
  });
});

describe("PwrSnap transcript images", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "pwragent-pwrsnap-images-"));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(tempDir, { recursive: true, force: true });
  });

  const urlArb = fc.oneof(
    fc.constantFrom(...URIS.slice(0, 3)),
    fc.constant("http://127.0.0.1:51729/media?grant=old&signature=old"),
    fc.constant("http://127.0.0.1:51730/media?grant=other&signature=other"),
    fc.constant("https://example.com/c0.png"),
  );

  it("materializes only links the gateway can read, and requests nothing itself", async () => {
    const { materializeTranscriptImageUrlsForRenderer } = await import("../transcript-images");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let run = 0;
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(urlArb, { minLength: 1, maxLength: 6 }),
      fc.subarray(URIS.slice(0, 3)),
      async (urls, readable) => {
        run += 1;
        const reads: string[] = [];
        const response = await materializeTranscriptImageUrlsForRenderer({
          backend: "codex",
          fetchedAt: 1,
          threadId: "thread-a",
          replay: {
            entries: [],
            messages: [{
              id: "reply",
              role: "assistant",
              text: "Shown.",
              parts: urls.map((url) => ({ type: "image" as const, url })),
            }],
            pagination: { supportsPagination: false, hasPreviousPage: false },
          },
        }, {
          resolveRoot: () => path.join(tempDir, `run-${run}`),
          readPwrSnapMedia: async ({ threadId, uri }) => {
            reads.push(uri);
            return threadId === "thread-a" && readable.includes(uri)
              ? { ok: true, mimeType: "image/png", dataBase64: "AQID" }
              : { ok: false, reason: "session-ended" };
          },
        });

        const parts = response.replay.messages[0]?.parts ?? [];
        expect(parts).toHaveLength(urls.length);
        urls.forEach((url, index) => {
          const part = parts[index];
          if (part?.type !== "image") throw new Error("expected an image part");
          if (url.startsWith("pwrsnap://") && readable.includes(url)) {
            expect(part.url).toMatch(/^pwragent-image:\/\/file\//);
            expect(part.unavailableReason).toBeUndefined();
          } else if (url.startsWith("pwrsnap://") || url.startsWith("http://127.0.0.1:51729/")) {
            expect(part.url).toBe(url);
            expect(part.unavailableReason).toEqual(expect.any(String));
          } else {
            expect(part).toEqual({ type: "image", url });
          }
        });
        // Only PwrSnap links reach the gateway, and nothing goes over HTTP.
        expect(reads.every((uri) => uri.startsWith("pwrsnap://"))).toBe(true);
        expect(fetch).not.toHaveBeenCalled();
      },
    ), { numRuns: 100 });
  });
});
