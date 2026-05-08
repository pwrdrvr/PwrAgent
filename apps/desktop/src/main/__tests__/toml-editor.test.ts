import { describe, expect, it } from "vitest";
import { applyTomlEdits } from "../settings/toml-editor";

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
