import { describe, expect, it } from "vitest";
import {
  formatAutomationRunRuntime,
  formatAutomationRunUsage,
  formatCostTodayMicros,
  formatWorkspacePathLabel,
} from "../automation-format";

describe("formatWorkspacePathLabel", () => {
  it("keeps the last two segments of a POSIX path", () => {
    expect(formatWorkspacePathLabel("/Users/dev/pwrdrvr/search-signals")).toBe(
      "…/pwrdrvr/search-signals",
    );
  });

  it("keeps the last two segments of a Windows path, in Windows separators", () => {
    // The whole point of shortening is that the tail survives the cell width.
    // Splitting on "/" alone returned this untouched, and CSS then ellipsised
    // away "search-signals" — the only part that says which repo it is.
    expect(
      formatWorkspacePathLabel("C:\\Users\\dev\\pwrdrvr\\search-signals"),
    ).toBe("…\\pwrdrvr\\search-signals");
  });

  it("shortens a UNC path without mangling it into POSIX", () => {
    expect(formatWorkspacePathLabel("\\\\build\\share\\team\\repo")).toBe(
      "…\\team\\repo",
    );
  });

  it("leaves short paths alone rather than prefixing a lie", () => {
    // Nothing was dropped, so an ellipsis would claim a parent that is not there.
    expect(formatWorkspacePathLabel("/srv/repo")).toBe("/srv/repo");
    expect(formatWorkspacePathLabel("C:\\repo")).toBe("C:\\repo");
  });

  it("ignores a trailing separator", () => {
    expect(formatWorkspacePathLabel("/Users/dev/pwrdrvr/repo/")).toBe(
      "…/pwrdrvr/repo",
    );
  });
});

describe("formatAutomationRunUsage", () => {
  it("renders cost with the sub-cent precision the app uses elsewhere", () => {
    expect(
      formatAutomationRunUsage({
        totalCostMicros: 52_000,
        uncachedInputTokens: 780_000,
        cachedInputTokens: 2_900,
        outputTokens: 7_500,
      }),
    ).toBe("$0.052 · 782.9k in · 7.5k out");
  });

  it("rounds to cents once the run is worth more than a dime", () => {
    expect(formatAutomationRunUsage({ totalCostMicros: 480_000 })).toBe("$0.48");
  });

  it("omits the line entirely when a run recorded no usage", () => {
    expect(formatAutomationRunUsage(undefined)).toBeUndefined();
    expect(formatAutomationRunUsage({})).toBeUndefined();
  });
});

describe("formatAutomationRunRuntime", () => {
  it("joins model and the effort the run actually used", () => {
    expect(
      formatAutomationRunRuntime({ model: "gpt-5.6-luna", reasoningEffort: "xhigh" }),
    ).toBe("gpt-5.6-luna · xhigh");
  });

  it("drops the separator when only one half is known", () => {
    expect(formatAutomationRunRuntime({ model: "gpt-5.6-luna" })).toBe(
      "gpt-5.6-luna",
    );
    expect(formatAutomationRunRuntime({})).toBeUndefined();
  });
});

describe("formatCostTodayMicros", () => {
  it("says nothing when no run today recorded a cost", () => {
    expect(formatCostTodayMicros(undefined)).toBeUndefined();
  });

  it("labels the figure so it cannot be read as a lifetime total", () => {
    expect(formatCostTodayMicros(480_000)).toBe("$0.48 today");
  });
});
