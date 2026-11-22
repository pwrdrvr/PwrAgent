import { readFile } from "node:fs/promises";
import {
  createLineRichMenuApi,
  LINE_RICH_MENU_LAYOUT,
  LINE_RICH_MENU_VERSION,
  LineRichMenuSetup,
  LineRichMenuSetupError,
  validateLineUserId,
} from "@pwragent/messaging-provider-line";
import type { LineRichMenuSetupRequest, LineRichMenuSetupResponse } from "@pwragent/shared/contracts/settings";
import { createLineRichMenuSetupStorage } from "../storage/line-rich-menu-setup-storage";

export async function runLineRichMenuSetup(
  channelAccessToken: string | undefined,
  request: LineRichMenuSetupRequest,
  imagePath: string,
): Promise<LineRichMenuSetupResponse> {
  if (!channelAccessToken) return { kind: "unconfigured" };
  if (request?.action !== "check"
    && (!(request?.action === "install" || request?.action === "remove") || !validateLineUserId(request.accountId).ok)) {
    return { kind: "error", reason: "request-failed" };
  }
  try {
    const image = await readFile(imagePath);
    const setup = new LineRichMenuSetup(createLineRichMenuApi(channelAccessToken), createLineRichMenuSetupStorage(), {
      image: new Blob([new Uint8Array(image)], { type: "image/png" }),
      menu: LINE_RICH_MENU_LAYOUT,
      revision: LINE_RICH_MENU_VERSION,
    });
    if (request.action === "install") await setup.install(request.accountId);
    if (request.action === "remove") await setup.remove(request.accountId);
    return {
      ...await setup.inspect(),
      preview: `data:image/png;base64,${image.toString("base64")}`,
      version: LINE_RICH_MENU_VERSION,
    };
  } catch (error) {
    const reason = error instanceof LineRichMenuSetupError ? error.code : "request-failed";
    if (reason === "administrator" || reason === "different-menu") {
      return { kind: "error", reason: "changed" };
    }
    return { kind: "error", reason };
  }
}
