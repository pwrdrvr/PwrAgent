import { describe, expect, it } from "vitest";
import { formatSearchCommandActionLabel, unwrapCommandText } from "../command-action-labels";

describe("formatSearchCommandActionLabel", () => {
  it("prefers the search query over its root path", () => {
    expect(
      formatSearchCommandActionLabel({
        query: "grok",
        path: ".",
      }),
    ).toBe('Searched "grok"');
  });

  it("keeps slashes in search queries", () => {
    expect(
      formatSearchCommandActionLabel({
        query: "src/main.rs",
        path: ".",
      }),
    ).toBe('Searched "src/main.rs"');
  });

  it("falls back to a meaningful path basename", () => {
    expect(
      formatSearchCommandActionLabel({
        query: null,
        path: "apps/desktop/src",
      }),
    ).toBe("Searched src");
  });

  it("omits unhelpful root-only paths", () => {
    expect(formatSearchCommandActionLabel({ query: null, path: "." })).toBe(
      "Searched",
    );
    expect(formatSearchCommandActionLabel({ query: null, path: "/" })).toBe(
      "Searched",
    );
  });
});

describe("unwrapCommandText", () => {
  it("keeps line breaks and indentation when unwrapping a plain sh -c script", () => {
    expect(unwrapCommandText('sh -c "pwd\n  pwd"')).toBe("pwd\n  pwd");
  });
});
