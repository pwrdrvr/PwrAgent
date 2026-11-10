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
 * session that returned it, for that session's own thread. Links the model
 * wrote, another MCP server returned, or an ended (or replaced) session
 * returned are never read.
 */

/** Bridge tokens, one per thread and connection, as the gateway issues them. */
const TOKENS = {
  snapA: { connectionId: "pwrsnap", threadId: "thread-a" },
  // The `call_mcp_tool` path has its own PwrSnap session on the same thread.
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

const blockArb = fc.record({
  type: fc.constantFrom("resource_link", "image", "text"),
  uri: fc.constantFrom(...URIS),
  mimeType: fc.constantFrom("image/png", "IMAGE/JPEG", "video/mp4", undefined),
});

type Command =
  | { kind: "open"; token: Token }
  | { kind: "close"; token: Token }
  | { kind: "drop"; token: Token }
  | { kind: "result"; token: Token; blocks: Array<{ type: string; uri: string; mimeType?: string }> }
  | { kind: "query"; threadId: string; uri: string };

const tokenArb = fc.constantFrom(...TOKEN_NAMES);
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant("open" as const), token: tokenArb }),
  fc.record({ kind: fc.constant("close" as const), token: tokenArb }),
  // The session died, and a new one may open on the same token before
  // anything forgets the old one's links.
  fc.record({ kind: fc.constant("drop" as const), token: tokenArb }),
  fc.record({ kind: fc.constant("result" as const), token: tokenArb, blocks: fc.array(blockArb, { maxLength: 4 }) }),
  fc.record({ kind: fc.constant("query" as const), threadId: fc.constantFrom(...THREADS), uri: fc.constantFrom(...URIS) }),
);

describe("PwrSnap media links", () => {
  it("answers only for a link the thread's own live PwrSnap session returned", () => {
    fc.assert(fc.property(fc.array(commandArb, { maxLength: 60 }), (commands) => {
      const links = new PwrSnapMediaLinks();
      const live = new Map<Token, object>();
      // Model: what each session object returned while it was live.
      const returned = new Map<object, Set<string>>();
      const lookup = {
        liveSession: (token: string) => live.get(token as Token),
        threadOf: (token: string) => TOKENS[token as Token]?.threadId,
      };

      for (const command of commands) {
        switch (command.kind) {
          case "open":
          case "drop": {
            if (command.kind === "open") links.forget(command.token);
            const session = {};
            live.set(command.token, session);
            returned.set(session, new Set());
            break;
          }
          case "close":
            live.delete(command.token);
            links.forget(command.token);
            break;
          case "result": {
            const session = live.get(command.token);
            if (!session) break;
            const result = { content: command.blocks };
            links.record(command.token, TOKENS[command.token].connectionId, session, result);
            if (TOKENS[command.token].connectionId !== "pwrsnap") break;
            for (const block of command.blocks) {
              if (
                block.type === "resource_link"
                && block.mimeType?.toLowerCase().startsWith("image/")
                && block.uri.startsWith("pwrsnap://")
              ) {
                returned.get(session)!.add(block.uri);
              }
            }
            break;
          }
          case "query": {
            const allowed = TOKEN_NAMES.filter((token) => {
              const session = live.get(token);
              return TOKENS[token].threadId === command.threadId
                && session !== undefined
                && returned.get(session)!.has(command.uri);
            });
            const answer = links.resolve(command.threadId, command.uri, lookup);
            if (allowed.length === 0) {
              expect(answer).toBeUndefined();
            } else {
              expect(allowed).toContain(answer);
            }
          }
        }
      }
    }), { numRuns: 500 });
  });

  it("forgets a session's oldest links past its limit", () => {
    const links = new PwrSnapMediaLinks();
    const session = {};
    const lookup = { liveSession: () => session, threadOf: () => "thread-a" };
    for (let index = 0; index <= MAX_PWRSNAP_MEDIA_LINKS_PER_SESSION; index += 1) {
      links.record("snapA", "pwrsnap", session, {
        content: [{ type: "resource_link", uri: `pwrsnap://capture/c${index}/composite`, mimeType: "image/png" }],
      });
    }
    expect(links.resolve("thread-a", "pwrsnap://capture/c0/composite", lookup)).toBeUndefined();
    expect(links.resolve("thread-a", "pwrsnap://capture/c1/composite", lookup)).toBe("snapA");
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
