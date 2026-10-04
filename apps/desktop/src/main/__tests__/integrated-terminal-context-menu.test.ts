import { describe, expect, it } from "vitest";
import { buildIntegratedTerminalContextMenuTemplate } from "../terminal/integrated-terminal-context-menu";

describe("integrated terminal context menu", () => {
  it.each([
    ["linux", "Control+Shift+C", "Control+Shift+V"],
    ["win32", "Control+Shift+C", "Control+V"],
    ["darwin", "Command+C", "Command+V"],
  ] as const)("shows the host platform's terminal shortcuts on %s", (platform, copy, paste) => {
    expect(buildIntegratedTerminalContextMenuTemplate(platform, true)).toEqual([
      { role: "copy", enabled: true, accelerator: copy, registerAccelerator: false },
      { role: "paste", accelerator: paste, registerAccelerator: false },
    ]);
  });

  it("disables copy when the terminal has no selection", () => {
    expect(buildIntegratedTerminalContextMenuTemplate("linux", false)[0]?.enabled).toBe(false);
  });
});
