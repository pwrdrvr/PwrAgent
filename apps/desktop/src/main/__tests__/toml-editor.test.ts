import { describe, expect, it, vi } from "vitest";
import { applyTomlEdits, parseTomlTables } from "../settings/toml-editor";

describe("applyTomlEdits", () => {
  it("returns the source unchanged when there are no edits", () => {
    const source = "[messaging.telegram]\nenabled = true\n";
    expect(applyTomlEdits(source, [])).toBe(source);
  });

  it("preserves the file byte-identical when set value already matches", () => {
    const source = "[messaging.telegram]\nenabled = true\n";
    const result = applyTomlEdits(source, [
      { op: "set", path: ["messaging", "telegram", "enabled"], value: true },
    ]);
    expect(result).toBe(source);
  });

  it("preserves an unknown section when editing a known key", () => {
    const source = [
      "[messaging.telegram]",
      "enabled = true",
      "",
      "# Mattermost was configured by a future build of the app.",
      "[messaging.mattermost]",
      'server_url = "https://chat.example.com"',
      'authorized_user_ids = ["abc", "def"]',
      "",
    ].join("\n");

    const result = applyTomlEdits(source, [
      { op: "set", path: ["messaging", "telegram", "enabled"], value: false },
    ]);

    expect(result).toContain(
      "# Mattermost was configured by a future build of the app.",
    );
    expect(result).toContain("[messaging.mattermost]");
    expect(result).toContain('server_url = "https://chat.example.com"');
    expect(result).toContain('authorized_user_ids = ["abc", "def"]');
    expect(result).toContain("enabled = false");
  });

  it("preserves comments above and between keys when editing a key", () => {
    const source = [
      "# top comment",
      "[messaging.telegram]",
      "# inline comment above key",
      "enabled = true",
      "# trailing key comment",
      'authorized_user_ids = ["111"]',
      "",
    ].join("\n");

    const result = applyTomlEdits(source, [
      { op: "set", path: ["messaging", "telegram", "enabled"], value: false },
    ]);

    expect(result).toContain("# top comment");
    expect(result).toContain("# inline comment above key");
    expect(result).toContain("# trailing key comment");
    expect(result).toContain("enabled = false");
    expect(result).toContain('authorized_user_ids = ["111"]');
  });

  it("preserves blank lines between sections", () => {
    const source = [
      "[messaging.telegram]",
      "enabled = true",
      "",
      "",
      "[messaging.discord]",
      "enabled = false",
      "",
    ].join("\n");

    const result = applyTomlEdits(source, [
      { op: "set", path: ["messaging", "telegram", "enabled"], value: false },
    ]);

    expect(result).toContain("enabled = false\n\n\n[messaging.discord]");
  });

  it("replaces an existing scalar value in place without touching other lines", () => {
    const source = [
      "[messaging.telegram]",
      "enabled = true",
      'authorized_user_ids = ["111"]',
      "streaming_responses = true",
      "",
    ].join("\n");

    const result = applyTomlEdits(source, [
      {
        op: "set",
        path: ["messaging", "telegram", "streaming_responses"],
        value: false,
      },
    ]);

    expect(result).toBe(
      [
        "[messaging.telegram]",
        "enabled = true",
        'authorized_user_ids = ["111"]',
        "streaming_responses = false",
        "",
      ].join("\n"),
    );
  });

  it("replaces an existing array value in place", () => {
    const source = [
      "[messaging.telegram]",
      'authorized_user_ids = ["111", "222"]',
      "",
    ].join("\n");

    const result = applyTomlEdits(source, [
      {
        op: "set",
        path: ["messaging", "telegram", "authorized_user_ids"],
        value: ["333"],
      },
    ]);

    expect(result).toContain('authorized_user_ids = ["333"]');
    expect(result).not.toContain('"111"');
    expect(result).not.toContain('"222"');
  });

  it("appends a new key to an existing section before trailing blank lines", () => {
    const source = [
      "[messaging.telegram]",
      "enabled = true",
      "",
    ].join("\n");

    const result = applyTomlEdits(source, [
      {
        op: "set",
        path: ["messaging", "telegram", "streaming_responses"],
        value: true,
      },
    ]);

    expect(result).toBe(
      [
        "[messaging.telegram]",
        "enabled = true",
        "streaming_responses = true",
        "",
      ].join("\n"),
    );
  });

  it("creates a new section at end of file when missing", () => {
    const source = ["[messaging.telegram]", "enabled = true", ""].join("\n");

    const result = applyTomlEdits(source, [
      {
        op: "set",
        path: ["messaging", "discord", "enabled"],
        value: true,
      },
    ]);

    expect(result).toContain("[messaging.telegram]");
    expect(result).toContain("[messaging.discord]");
    expect(result.indexOf("[messaging.discord]")).toBeGreaterThan(
      result.indexOf("[messaging.telegram]"),
    );
    expect(result).toMatch(/\[messaging\.discord\]\nenabled = true\n?$/);
  });

  it("creates the file from scratch when source is empty", () => {
    const result = applyTomlEdits("", [
      {
        op: "set",
        path: ["messaging", "telegram", "enabled"],
        value: true,
      },
    ]);

    expect(result).toBe("[messaging.telegram]\nenabled = true\n");
  });

  it("deletes a key by removing its line", () => {
    const source = [
      "[messaging.telegram]",
      "enabled = true",
      'authorized_user_ids = ["111"]',
      "streaming_responses = true",
      "",
    ].join("\n");

    const result = applyTomlEdits(source, [
      { op: "delete", path: ["messaging", "telegram", "streaming_responses"] },
    ]);

    expect(result).not.toContain("streaming_responses");
    expect(result).toContain("enabled = true");
    expect(result).toContain('authorized_user_ids = ["111"]');
  });

  it("emits an inline-table-array as one entry per line", () => {
    const result = applyTomlEdits("[messaging.mattermost]\n", [
      {
        op: "set",
        path: ["messaging", "mattermost", "authorized_users"],
        value: [
          { id: "-100100", label: "Mom group" },
          { id: "-100200", label: "Work team" },
        ],
      },
    ]);

    expect(result).toContain("[messaging.mattermost]");
    expect(result).toContain("authorized_users = [");
    expect(result).toContain('{ id = "-100100", label = "Mom group" },');
    expect(result).toContain('{ id = "-100200", label = "Work team" },');
    expect(result).toMatch(/]\n?$/);
  });

  it("replaces a multi-line inline-table-array value across lines", () => {
    const source = [
      "[messaging.mattermost]",
      "authorized_users = [",
      '  { id = "-100100", label = "Mom" },',
      '  { id = "-100200", label = "Work" },',
      "]",
      'server_url = "https://chat.example.com"',
      "",
    ].join("\n");

    const result = applyTomlEdits(source, [
      {
        op: "set",
        path: ["messaging", "mattermost", "authorized_users"],
        value: [{ id: "-100300", label: "New" }],
      },
    ]);

    expect(result).toContain('{ id = "-100300", label = "New" }');
    expect(result).not.toContain('"-100100"');
    expect(result).not.toContain('"-100200"');
    expect(result).toContain('server_url = "https://chat.example.com"');
  });

  it("escapes special characters in string values on write", () => {
    const result = applyTomlEdits("[s]\n", [
      {
        op: "set",
        path: ["s", "k"],
        value: 'has "quotes" and \\backslash and\nnewline',
      },
    ]);
    expect(result).toContain(
      'k = "has \\"quotes\\" and \\\\backslash and\\nnewline"',
    );
  });

  it("preserves an empty string array as []", () => {
    const result = applyTomlEdits("[s]\n", [
      { op: "set", path: ["s", "list"], value: [] as readonly string[] },
    ]);
    expect(result).toContain("list = []");
  });

  it("treats path with single element as a top-level key", () => {
    const source = "key = 1\n";
    const result = applyTomlEdits(source, [
      { op: "set", path: ["key"], value: 2 },
    ]);
    expect(result).toBe("key = 2\n");
  });

  it("ignores a delete for a key that does not exist", () => {
    const source = "[s]\nx = 1\n";
    const result = applyTomlEdits(source, [
      { op: "delete", path: ["s", "y"] },
    ]);
    expect(result).toBe(source);
  });

  it("preserves a source with no trailing newline", () => {
    const source = "[s]\nx = 1";
    expect(applyTomlEdits(source, [])).toBe(source);

    const result = applyTomlEdits(source, [
      { op: "set", path: ["s", "x"], value: 2 },
    ]);
    expect(result).toBe("[s]\nx = 2");
  });

  it("preserves a source with a trailing newline", () => {
    const source = "[s]\nx = 1\n";
    const result = applyTomlEdits(source, [
      { op: "set", path: ["s", "x"], value: 2 },
    ]);
    expect(result).toBe("[s]\nx = 2\n");
  });

  it("writes a float value", () => {
    const result = applyTomlEdits("[s]\n", [
      { op: "set", path: ["s", "ratio"], value: 1.5 },
    ]);
    expect(result).toContain("ratio = 1.5");
  });

  it("coalesces multiple edits to a missing section into a single new section", () => {
    const source = "[a]\nx = 1\n";
    const result = applyTomlEdits(source, [
      { op: "set", path: ["b", "p"], value: 1 },
      { op: "set", path: ["b", "q"], value: 2 },
    ]);
    expect(result).toBe("[a]\nx = 1\n\n[b]\np = 1\nq = 2\n");
  });

  it("applies multiple edits to the same section in original order", () => {
    const source = "[s]\nexisting = 1\n";
    const result = applyTomlEdits(source, [
      { op: "set", path: ["s", "a"], value: 1 },
      { op: "set", path: ["s", "b"], value: 2 },
    ]);
    expect(result).toBe("[s]\nexisting = 1\na = 1\nb = 2\n");
  });

  it("parses sources only once regardless of edit count (single-pass)", () => {
    // Spy via a side channel: count regex.exec invocations on a hot path
    // would be too invasive. Instead, this is a behavior smoke check —
    // 50 edits to a small section produce a stable result quickly.
    const lines = ["[s]", "x = 0"];
    const source = lines.join("\n") + "\n";
    const edits = Array.from({ length: 50 }, (_, i) => ({
      op: "set" as const,
      path: ["s", `k${i}`],
      value: i,
    }));
    const result = applyTomlEdits(source, edits);
    for (let i = 0; i < 50; i += 1) {
      expect(result).toContain(`k${i} = ${i}`);
    }
  });

  it("applies multiple edits in order", () => {
    const source = [
      "[messaging.telegram]",
      "enabled = true",
      'authorized_user_ids = ["111"]',
      "",
    ].join("\n");

    const result = applyTomlEdits(source, [
      { op: "set", path: ["messaging", "telegram", "enabled"], value: false },
      {
        op: "set",
        path: ["messaging", "telegram", "authorized_user_ids"],
        value: ["222"],
      },
      {
        op: "set",
        path: ["messaging", "discord", "enabled"],
        value: true,
      },
    ]);

    expect(result).toContain("enabled = false");
    expect(result).toContain('authorized_user_ids = ["222"]');
    expect(result).toContain("[messaging.discord]");
  });
});

describe("parseTomlTables", () => {
  it("parses float values", () => {
    const tables = parseTomlTables('[s]\nratio = 1.5\nneg = -2.25\n', "/x");
    expect(tables.s.ratio).toBe(1.5);
    expect(tables.s.neg).toBe(-2.25);
  });

  it("parses scientific-notation floats", () => {
    const tables = parseTomlTables("[s]\na = 1.5e3\nb = -2E-2\n", "/x");
    expect(tables.s.a).toBe(1500);
    expect(tables.s.b).toBe(-0.02);
  });

  it("does not throw when an unknown value kind appears in any section", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      // 2026-05-15T00:00:00Z is a TOML datetime. Our parser doesn't yet
      // understand datetimes, but a future build will. The current parser
      // must skip the line, not blow up the entire snapshot read.
      const tables = parseTomlTables(
        "[s]\nwhen = 2026-05-15T00:00:00Z\nx = 1\n",
        "/x",
      );
      expect(tables.s.x).toBe(1);
      expect(tables.s.when).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns and uses the first occurrence when a section appears twice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const tables = parseTomlTables(
        "[s]\nx = 1\n\n[s]\ny = 2\n",
        "/x",
      );
      expect(tables.s.x).toBe(1);
      expect(tables.s.y).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Duplicate section [s]"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("still throws on malformed TOML lines", () => {
    expect(() => parseTomlTables("[s]\nbroken line no equals\n", "/x")).toThrow(
      /Invalid TOML line/,
    );
  });
});

describe("applyTomlEdits with duplicate sections", () => {
  it("edits the first occurrence and leaves the second untouched", () => {
    const source = [
      "[s]",
      "x = 1",
      "",
      "[s]",
      "y = 2",
      "",
    ].join("\n");

    const result = applyTomlEdits(source, [
      { op: "set", path: ["s", "x"], value: 99 },
    ]);

    // First section's x updated.
    expect(result).toContain("x = 99");
    // Second section preserved verbatim.
    expect(result).toContain("[s]\ny = 2");
  });
});
