import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GUIDED_MESSAGING_PROVIDERS,
  currentMessagingProvider,
  initialMessagingSetupState,
  reduceMessagingSetup,
  stepConnectsProviders,
  visibleMessagingStep,
  type GuidedMessagingProvider,
  type MessagingSetupEvent,
} from "../messaging-setup-flow";

const providerArb = fc.constantFrom<GuidedMessagingProvider>(
  ...GUIDED_MESSAGING_PROVIDERS,
);

const eventArb: fc.Arbitrary<MessagingSetupEvent> = fc.oneof(
  fc.constant<MessagingSetupEvent>({ type: "next" }),
  fc.constant<MessagingSetupEvent>({ type: "back" }),
  fc.constant<MessagingSetupEvent>({ type: "skip-provider" }),
  providerArb.map<MessagingSetupEvent>((provider) => ({
    type: "toggle-provider",
    provider,
  })),
);

/** One operator action, under whatever the stored record says right then.
 *  The record can appear (Continue wrote it) or vanish (another window
 *  cleared it in Settings → General) between any two actions. */
const stepArb = fc.record({
  event: eventArb,
  acknowledgedOnRecord: fc.boolean(),
});

describe("guided messaging setup gate", () => {
  it("never shows a step that connects providers without a stored acknowledgement", () => {
    fc.assert(
      fc.property(
        fc.option(providerArb, { nil: undefined }),
        fc.boolean(),
        fc.array(stepArb, { maxLength: 40 }),
        (entryProvider, startAcknowledged, steps) => {
          let state = initialMessagingSetupState(entryProvider, startAcknowledged);
          const check = (acknowledged: boolean): void => {
            const visible = visibleMessagingStep(state, acknowledged);
            if (!acknowledged) {
              expect(stepConnectsProviders(visible)).toBe(false);
              expect(currentMessagingProvider(state, acknowledged)).toBeUndefined();
            }
          };
          check(startAcknowledged);
          for (const { event, acknowledgedOnRecord } of steps) {
            check(acknowledgedOnRecord);
            state = reduceMessagingSetup(state, event, acknowledgedOnRecord);
            check(acknowledgedOnRecord);
          }
        },
      ),
    );
  });

  it("leaves the safety screen only on Continue with the record stored", () => {
    fc.assert(
      fc.property(
        fc.option(providerArb, { nil: undefined }),
        fc.array(eventArb, { maxLength: 30 }),
        (entryProvider, events) => {
          // Without a record, nothing the operator does moves the flow off
          // the safety screen.
          let state = initialMessagingSetupState(entryProvider, false);
          for (const event of events) {
            state = reduceMessagingSetup(state, event, false);
            expect(visibleMessagingStep(state, false)).toBe("safety");
          }
          // With one, Continue goes straight to the provider it opened on,
          // or to the picker.
          const next = reduceMessagingSetup(
            initialMessagingSetupState(entryProvider, false),
            { type: "next" },
            true,
          );
          expect(next.step).toBe(entryProvider ? "provider-setup" : "providers");
          if (entryProvider) {
            expect(currentMessagingProvider(next, true)).toBe(entryProvider);
          }
        },
      ),
    );
  });

  it("visits every picked provider once, in setup order, then reviews", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(providerArb, { minLength: 1, maxLength: 6 }),
        (picks) => {
          let state = initialMessagingSetupState(undefined, true);
          // The picker opens with Telegram picked; clear it first.
          state = reduceMessagingSetup(
            state,
            { type: "toggle-provider", provider: "telegram" },
            true,
          );
          for (const provider of picks) {
            state = reduceMessagingSetup(
              state,
              { type: "toggle-provider", provider },
              true,
            );
          }
          state = reduceMessagingSetup(state, { type: "next" }, true);
          const visited: GuidedMessagingProvider[] = [];
          while (state.step === "provider-setup") {
            const provider = currentMessagingProvider(state, true);
            if (provider) visited.push(provider);
            state = reduceMessagingSetup(state, { type: "next" }, true);
          }
          expect(state.step).toBe("done");
          expect(visited).toEqual(
            GUIDED_MESSAGING_PROVIDERS.filter((id) => picks.includes(id)),
          );
        },
      ),
    );
  });

  it("opens past the safety screen when the record already exists", () => {
    expect(initialMessagingSetupState("discord", true).step).toBe("provider-setup");
    expect(initialMessagingSetupState(undefined, true).step).toBe("providers");
    expect(initialMessagingSetupState("discord", false).step).toBe("safety");
  });
});
