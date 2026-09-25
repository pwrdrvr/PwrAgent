import { describe, expect, it } from "vitest";
import { isSafeExternalOpenUrl, isSlackAppDeepLink } from "../external-url-policy";

describe("isSlackAppDeepLink", () => {
  it("accepts the Slack app's Messages tab link", () => {
    expect(
      isSlackAppDeepLink("slack://app?team=T0FAKETEAM1&id=A0FAKEAPP01&tab=messages"),
    ).toBe(true);
  });

  it("refuses any other slack: link", () => {
    for (const url of [
      "slack://app?team=T0FAKETEAM1&id=A0FAKEAPP01&tab=home",
      "slack://app?team=T0FAKETEAM1&id=A0FAKEAPP01",
      "slack://app?team=T0FAKETEAM1&id=A0FAKEAPP01&tab=messages&x=1",
      "slack://app?team=T0FAKETEAM1&id=U0FAKEUSER1&tab=messages",
      "slack://user?team=T0FAKETEAM1&id=A0FAKEAPP01&tab=messages",
      "slack://app/extra?team=T0FAKETEAM1&id=A0FAKEAPP01&tab=messages",
      "slack://app?team=bad&id=A0FAKEAPP01&tab=messages",
      "https://app?team=T0FAKETEAM1&id=A0FAKEAPP01&tab=messages",
      "not a url",
    ]) {
      expect(isSlackAppDeepLink(url), url).toBe(false);
    }
  });

  it("stays out of the general gate for links from rendered markdown", () => {
    expect(
      isSafeExternalOpenUrl("slack://app?team=T0FAKETEAM1&id=A0FAKEAPP01&tab=messages"),
    ).toBe(false);
  });
});
