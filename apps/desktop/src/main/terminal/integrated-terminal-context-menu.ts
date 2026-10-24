import type { MenuItemConstructorOptions } from "electron";

export function buildIntegratedTerminalContextMenuTemplate(
  platform: NodeJS.Platform,
  canCopy: boolean,
): MenuItemConstructorOptions[] {
  return [
    {
      role: "copy",
      enabled: canCopy,
      accelerator: platform === "darwin" ? "Command+C" : "Control+Shift+C",
      registerAccelerator: false,
    },
    {
      role: "paste",
      accelerator: platform === "darwin"
        ? "Command+V"
        : platform === "linux" ? "Control+Shift+V" : "Control+V",
      registerAccelerator: false,
    },
  ];
}
