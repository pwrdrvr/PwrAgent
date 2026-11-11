import { createHmac } from "node:crypto";
import type { LineAdapter } from "../../line-adapter.ts";

/**
 * The URL of a started adapter's webhook listener. Tests construct the
 * adapter with `listenPort: 0` and address it only through the port it
 * reports holding, never a number chosen beforehand.
 */
export function webhookUrl(adapter: LineAdapter): string {
  const port = adapter.listeningPort;
  if (port === undefined) {
    throw new Error("LINE adapter is not listening; start it before posting");
  }
  return `http://127.0.0.1:${port}/`;
}

export async function postLineWebhook(
  adapter: LineAdapter,
  channelSecret: string,
  body: unknown,
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const signature = createHmac("sha256", channelSecret)
    .update(rawBody)
    .digest("base64");
  return await fetch(webhookUrl(adapter), {
    method: "POST",
    body: rawBody,
    headers: {
      "content-type": "application/json",
      "x-line-signature": signature,
    },
  });
}
