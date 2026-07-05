import { describe, expect, it } from "vitest";
import {
  parseBacktickFenceLine,
  repairNestedLanguageFences,
} from "../markdown-fences";

describe("parseBacktickFenceLine", () => {
  it("parses an opening fence with a language", () => {
    expect(parseBacktickFenceLine("```ts")).toMatchObject({
      length: 3,
      info: "ts",
    });
  });

  it("parses a longer bare fence", () => {
    expect(parseBacktickFenceLine("````")).toMatchObject({
      length: 4,
      info: "",
    });
  });

  it("rejects non-fence lines and short runs", () => {
    expect(parseBacktickFenceLine("not a fence")).toBeUndefined();
    expect(parseBacktickFenceLine("`` two")).toBeUndefined();
  });
});

describe("repairNestedLanguageFences", () => {
  it("lengthens the outer fence around a nested language fence", () => {
    const input = ["```", "```ts", "const value = 1;", "```", "```"].join("\n");
    const expected = ["````", "```ts", "const value = 1;", "```", "````"].join(
      "\n",
    );
    expect(repairNestedLanguageFences(input)).toBe(expected);
  });

  it("leaves a well-formed single code block untouched", () => {
    const input = ["```ts", "const value = 1;", "```"].join("\n");
    expect(repairNestedLanguageFences(input)).toBe(input);
  });

  it("leaves nested BARE fences untouched (only a nested language fence triggers a repair)", () => {
    const input = ["```", "```", "```"].join("\n");
    expect(repairNestedLanguageFences(input)).toBe(input);
  });

  it("returns text with no fences unchanged", () => {
    const input = "Just prose.\n\nMore prose.";
    expect(repairNestedLanguageFences(input)).toBe(input);
  });
});
