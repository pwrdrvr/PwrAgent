import { describe, expect, it } from "vitest";
import { validateCredentials } from "../validate-credentials.ts";

describe("Slack credential validation", () => {
  it("returns unset without a bot token", async () => {
    await expect(validateCredentials({ botToken: "" })).resolves.toMatchObject({
      status: "unset",
    });
  });

  it("returns account details from auth.test", async () => {
    await expect(
      validateCredentials(
        { botToken: "xoxb-test" },
        {
          authTest: async () => ({
            user: "pwragent",
            team: "PwrDrvr",
            url: "https://example.slack.com/",
          }),
        },
      ),
    ).resolves.toMatchObject({
      status: "ok",
      account: "pwragent",
      detail: "PwrDrvr",
    });
  });
});
