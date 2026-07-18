import { describe, expect, it } from "vitest";
import {
  buildThreadMarkdownLink,
  buildThreadUrl,
  isThreadLinkId,
  isThreadUrl,
  parseThreadUrl,
} from "../thread-link";

describe("buildThreadUrl", () => {
  it("emits a bare thread url when no backend or profile is given", () => {
    expect(buildThreadUrl({ threadId: "019f5d79-a595-73f2" })).toBe(
      "pwragent://thread/019f5d79-a595-73f2",
    );
  });

  it("carries backend and profile as query params", () => {
    expect(
      buildThreadUrl({
        threadId: "019f5d79",
        backend: "codex",
        profile: "sstk",
      }),
    ).toBe("pwragent://thread/019f5d79?backend=codex&profile=sstk");
  });

  it("percent-encodes an acp backend id rather than breaking the path", () => {
    const url = buildThreadUrl({
      threadId: "019f5d79",
      backend: "acp:claude-code",
    });

    expect(url).toBe("pwragent://thread/019f5d79?backend=acp%3Aclaude-code");
    expect(parseThreadUrl(url)?.backend).toBe("acp:claude-code");
  });
});

describe("parseThreadUrl", () => {
  it("round-trips every field", () => {
    const ref = {
      threadId: "019f5d79-a595-73f2-84d9-a0976762c303",
      backend: "codex",
      profile: "sstk",
    } as const;

    expect(parseThreadUrl(buildThreadUrl(ref))).toEqual(ref);
  });

  it("resolves a bare url with no backend hint", () => {
    expect(parseThreadUrl("pwragent://thread/019f5d79")).toEqual({
      threadId: "019f5d79",
      backend: undefined,
      profile: undefined,
    });
  });

  it("drops a backend that is not a known kind rather than trusting it", () => {
    expect(
      parseThreadUrl("pwragent://thread/019f5d79?backend=not-a-backend")?.backend,
    ).toBeUndefined();
  });

  it("rejects other schemes and hosts", () => {
    expect(parseThreadUrl("https://thread/019f5d79")).toBeUndefined();
    expect(parseThreadUrl("pwragent://settings/messaging")).toBeUndefined();
    expect(parseThreadUrl("pwragent://019f5d79")).toBeUndefined();
  });

  it("rejects reserved multi-segment shapes instead of navigating to the prefix", () => {
    // `.../turn/<turnId>` is reserved but not implemented. Parsing it as a
    // plain thread link would silently drop the part the author cared about.
    expect(
      parseThreadUrl("pwragent://thread/019f5d79/turn/turn-1"),
    ).toBeUndefined();
  });

  it("rejects an empty thread id", () => {
    expect(parseThreadUrl("pwragent://thread/")).toBeUndefined();
    expect(parseThreadUrl("pwragent://thread")).toBeUndefined();
  });

  it("rejects a malformed percent-escape rather than throwing", () => {
    expect(parseThreadUrl("pwragent://thread/%zz")).toBeUndefined();
  });

  it("ignores a fragment", () => {
    expect(parseThreadUrl("pwragent://thread/019f5d79#section")?.threadId).toBe(
      "019f5d79",
    );
  });

  it("accepts an uppercase scheme", () => {
    expect(parseThreadUrl("PWRAGENT://thread/019f5d79")?.threadId).toBe(
      "019f5d79",
    );
  });
});

describe("isThreadUrl", () => {
  it("separates thread links from every other href a transcript may carry", () => {
    expect(isThreadUrl("pwragent://thread/019f5d79")).toBe(true);
    expect(isThreadUrl("https://github.com/pwrdrvr/PwrAgnt")).toBe(false);
    expect(isThreadUrl("file:///Users/x/notes.md")).toBe(false);
    expect(isThreadUrl("not a url at all")).toBe(false);
  });
});

describe("isThreadLinkId", () => {
  it("accepts a thread uuid", () => {
    expect(isThreadLinkId("019f5d79-a595-73f2-84d9-a0976762c303")).toBe(true);
  });

  it("rejects values that would break the grammar or blow up the chip", () => {
    expect(isThreadLinkId("")).toBe(false);
    expect(isThreadLinkId("has whitespace")).toBe(false);
    expect(isThreadLinkId("has/slash")).toBe(false);
    expect(isThreadLinkId("has?query")).toBe(false);
    expect(isThreadLinkId("x".repeat(129))).toBe(false);
  });
});

describe("buildThreadMarkdownLink", () => {
  it("uses the thread title as link text", () => {
    expect(
      buildThreadMarkdownLink({
        threadId: "019f5d79",
        backend: "codex",
        title: "RELATED query deranking issue",
      }),
    ).toBe(
      "[RELATED query deranking issue](pwragent://thread/019f5d79?backend=codex)",
    );
  });

  it("falls back to the thread id when there is no title", () => {
    expect(buildThreadMarkdownLink({ threadId: "019f5d79" })).toBe(
      "[019f5d79](pwragent://thread/019f5d79)",
    );
  });

  it("escapes brackets so a title cannot break out of the link text", () => {
    expect(
      buildThreadMarkdownLink({
        threadId: "019f5d79",
        title: "fix [urgent] thing",
      }),
    ).toBe("[fix \\[urgent\\] thing](pwragent://thread/019f5d79)");
  });

  it("flattens newlines in a title onto one line", () => {
    expect(
      buildThreadMarkdownLink({ threadId: "019f5d79", title: "one\ntwo" }),
    ).toBe("[one two](pwragent://thread/019f5d79)");
  });
});
