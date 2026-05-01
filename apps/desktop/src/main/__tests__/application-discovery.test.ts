import { describe, expect, it } from "vitest";
import { buildGhosttyAppleScriptArgs } from "../settings/application-discovery";

describe("application discovery", () => {
  it("builds Ghostty AppleScript with an initial working directory", () => {
    expect(buildGhosttyAppleScriptArgs('/repo/.worktrees/feature "quoted"')).toEqual([
      "-e",
      'tell application "Ghostty"',
      "-e",
      "activate",
      "-e",
      "set cfg to new surface configuration",
      "-e",
      'set initial working directory of cfg to "/repo/.worktrees/feature \\"quoted\\""',
      "-e",
      "set win to new window with configuration cfg",
      "-e",
      "activate window win",
      "-e",
      "end tell",
    ]);
  });
});
