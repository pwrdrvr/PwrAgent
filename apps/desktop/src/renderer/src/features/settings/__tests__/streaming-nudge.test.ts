import { describe, expect, it } from "vitest";

import { shouldOfferStreamingNudge } from "../MessagingSettings.js";

const allOff = {
  telegram: false,
  discord: false,
  mattermost: false,
  slack: false,
  feishu: false,
  line: false,
};

describe("shouldOfferStreamingNudge", () => {
  it("offers the nudge when enabling the first provider with the global option off", () => {
    expect(
      shouldOfferStreamingNudge({
        showStreamingOption: false,
        enabledProviderKey: "telegram",
        providerStreaming: allOff,
      }),
    ).toBe(true);
  });

  it("does not nudge when the global option is already on", () => {
    expect(
      shouldOfferStreamingNudge({
        showStreamingOption: true,
        enabledProviderKey: "telegram",
        providerStreaming: allOff,
      }),
    ).toBe(false);
  });

  it("does not nudge when another provider already streams", () => {
    expect(
      shouldOfferStreamingNudge({
        showStreamingOption: false,
        enabledProviderKey: "discord",
        providerStreaming: { ...allOff, telegram: true },
      }),
    ).toBe(false);
  });

  it("still offers when only the provider being enabled shows as streaming", () => {
    // The excluded key is the one being toggled; its snapshot value may already
    // read true depending on timing, so it must not suppress its own nudge.
    expect(
      shouldOfferStreamingNudge({
        showStreamingOption: false,
        enabledProviderKey: "telegram",
        providerStreaming: { ...allOff, telegram: true },
      }),
    ).toBe(true);
  });
});
