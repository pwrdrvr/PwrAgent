import { describe, expect, it } from "vitest";
import { slackCredentialProblem } from "../slack-token-shape";

describe("slackCredentialProblem", () => {
  it("accepts each credential in its own box", () => {
    expect(slackCredentialProblem("bot", "xoxb-0000-fake")).toBeUndefined();
    expect(slackCredentialProblem("app", "xapp-1-fake")).toBeUndefined();
    expect(slackCredentialProblem("signing", "0123456789abcdef")).toBeUndefined();
  });

  it("names the credential that was pasted into the wrong box", () => {
    expect(slackCredentialProblem("bot", "xapp-1-fake")).toBe(
      "That is an App-Level Token (xapp-). The Bot User OAuth Token starts with xoxb-.",
    );
    expect(slackCredentialProblem("bot", "xoxp-0000-fake")).toBe(
      "That is a User OAuth Token (xoxp-). The Bot User OAuth Token starts with xoxb-.",
    );
    expect(slackCredentialProblem("app", "xoxb-0000-fake")).toBe(
      "That is the Bot User OAuth Token (xoxb-). The App-Level Token starts with xapp-.",
    );
    expect(slackCredentialProblem("signing", "xoxb-0000-fake")).toBe(
      "That is the Bot User OAuth Token (xoxb-). The Signing Secret is under Basic Information → App Credentials.",
    );
  });

  it("states the expected prefix for an unrecognized token", () => {
    expect(slackCredentialProblem("bot", "not-a-token")).toBe(
      "The Bot User OAuth Token starts with xoxb-.",
    );
    expect(slackCredentialProblem("app", "not-a-token")).toBe(
      "The App-Level Token starts with xapp-.",
    );
  });
});
