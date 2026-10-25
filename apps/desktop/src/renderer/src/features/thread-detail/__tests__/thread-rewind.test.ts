import { describe, expect, it } from "vitest";
import type { AppServerThreadEntry } from "@pwragent/shared";
import {
  collectRewindableMessageIds,
  rewoundPrompt,
  summarizeThreadRewind,
} from "../thread-rewind";

const entries: AppServerThreadEntry[] = [
  { type: "message", id: "u1", role: "user", text: "One", turn: { id: "t1" } },
  { type: "message", id: "a1", role: "assistant", text: "Reply", turn: { id: "t1" } },
  { type: "message", id: "u2", role: "user", text: "Two", turn: { id: "t2" } },
  { type: "message", id: "s2", role: "user", text: "Steer", turn: { id: "t2" } },
  {
    type: "activity",
    id: "edit",
    summary: "Edited files",
    details: [
      { id: "d1", kind: "write", label: "a.ts", path: "src/a.ts" },
      { id: "d2", kind: "write", label: "a.ts", path: "src/a.ts" },
      { id: "d3", kind: "read", label: "b.ts", path: "src/b.ts" },
    ],
    turn: { id: "t2" },
  },
  { type: "message", id: "u3", role: "user", text: "Three" },
];

describe("thread rewind targets", () => {
  it("offers the first prompt of each turn, and turnless prompts outside Codex", () => {
    expect([...collectRewindableMessageIds(entries, "acp:grok")]).toEqual(["u1", "u2", "u3"]);
    expect([...collectRewindableMessageIds(entries, "codex")]).toEqual(["u1", "u2"]);
  });

  it("counts the later turns and the distinct files a rewind removes", () => {
    expect(summarizeThreadRewind(entries, "u1", "acp:grok")).toEqual({
      laterTurnCount: 2,
      changedFileCount: 1,
    });
    expect(summarizeThreadRewind(entries, "u3", "acp:grok")).toEqual({
      laterTurnCount: 0,
      changedFileCount: 0,
    });
    expect(summarizeThreadRewind(entries, "missing", "codex")).toBeUndefined();
  });

  it("drops the file count when collapsed history hides an entry's details", () => {
    const collapsed: AppServerThreadEntry[] = [
      entries[0]!,
      {
        type: "activity",
        id: "collapsed",
        summary: "Edited files",
        details: [],
        detailsRef: {
          backend: "codex",
          threadId: "thread",
          turnId: "t1",
          entryId: "collapsed",
          revision: "1",
        },
      },
    ];
    expect(summarizeThreadRewind(collapsed, "u1", "codex")).toEqual({ laterTurnCount: 0 });
  });

  it("returns images the composer can send again and counts the rest", () => {
    const local = `pwragent-image://file/${encodeURIComponent("file:///Users/pat/shots/lock%20race.png")}`;
    const windows = `pwragent-image://file/${encodeURIComponent("file:///C:/Users/pat/trace.png")}`;
    const peer = `pwragent-image://federation/peer-1/${encodeURIComponent("/srv/shot.png")}`;
    const prompt = rewoundPrompt({
      type: "message",
      id: "u9",
      role: "user",
      text: "Why does this fail?",
      parts: [
        { type: "text", text: "Why does this fail?" },
        { type: "image", url: local },
        { type: "image", url: windows, alt: "trace" },
        { type: "image", url: "data:image/png;base64,AAAA" },
        { type: "image", url: peer },
        { type: "file", name: "notes.pdf" },
      ],
    });

    expect(prompt.text).toBe("Why does this fail?");
    expect(prompt.imageAttachments).toEqual([
      {
        id: "rewound:u9:image:1",
        name: "lock race.png",
        size: 0,
        type: "image/*",
        url: local,
        originalInput: { type: "localImage", name: "lock race.png", path: "/Users/pat/shots/lock race.png" },
      },
      {
        id: "rewound:u9:image:2",
        name: "trace",
        size: 0,
        type: "image/*",
        url: windows,
        originalInput: { type: "localImage", name: "trace", path: "C:/Users/pat/trace.png" },
      },
      {
        id: "rewound:u9:image:3",
        name: "Image",
        size: 0,
        type: "image/png",
        url: "data:image/png;base64,AAAA",
      },
    ]);
    expect(prompt.droppedAttachmentCount).toBe(2);
  });
});
