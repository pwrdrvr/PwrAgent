import { describe, expect, it } from "vitest";
import { textMatchesJumpQuery } from "../jump-search-text";

describe("textMatchesJumpQuery", () => {
  it.each([
    ["PwrSuiteLab", "PWS"],
    ["PwrSuiteLab", "psl"],
    ["PwrSuiteLab", "pwsl"],
    ["PwrAgent", "pa"],
    ["PwrSnap", "PS"],
    ["trading-system", "ts"],
    ["trading_system", "TS"],
    ["Trading System", "ts"],
    ["HTTPServer", "hs"],
    ["ÉquipeProjet", "ép"],
    ["C:\\repos\\PwrSuiteLab", "pws"],
    ["Fix PwrSuiteLab search", "pws"],
    ["Fix trading-system search", "ts"],
    ["PwrSuiteLab", "  suite  "],
    ["/repos/trading-system", "/repos/trading"],
  ])("matches %s with %s", (text, query) => {
    expect(textMatchesJumpQuery(text, query)).toBe(true);
  });

  it.each([
    ["PwrSuiteLab", "pl"],
    ["PwrSuiteLab", "pwa"],
    ["PwrSuiteLab", "puls"],
    ["PwrAgent", "pt"],
    ["/project/agent", "pa"],
    ["PwrAgent", "#pa"],
    ["PwrAgent", "p a"],
    ["alpha-beta", "ab OR missing"],
    ["PwrAgent", ""],
    ["PwrAgent", "   "],
    [undefined, "pa"],
  ])("rejects %s with %s", (text, query) => {
    expect(textMatchesJumpQuery(text, query)).toBe(false);
  });
});
