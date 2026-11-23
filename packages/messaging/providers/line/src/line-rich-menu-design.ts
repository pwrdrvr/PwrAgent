import type { LineRichMenuDesign } from "./line-rich-menu.ts";

export const LINE_RICH_MENU_VERSION = "v1";

export const LINE_RICH_MENU_LAYOUT = {
  size: { width: 2500, height: 843 },
  selected: false,
  chatBarText: "PwrAgent",
  areas: [
    {
      bounds: { x: 0, y: 0, width: 1250, height: 421 },
      action: { type: "message", label: "Resume", text: "/resume" },
    },
    {
      bounds: { x: 1250, y: 0, width: 1250, height: 421 },
      action: { type: "message", label: "New thread", text: "/resume --new" },
    },
    {
      bounds: { x: 0, y: 421, width: 833, height: 422 },
      action: { type: "message", label: "Status", text: "/status" },
    },
    {
      bounds: { x: 833, y: 421, width: 834, height: 422 },
      action: { type: "message", label: "Detach", text: "/detach" },
    },
    {
      bounds: { x: 1667, y: 421, width: 833, height: 422 },
      action: { type: "message", label: "Help", text: "/help" },
    },
  ],
} satisfies LineRichMenuDesign["menu"];
