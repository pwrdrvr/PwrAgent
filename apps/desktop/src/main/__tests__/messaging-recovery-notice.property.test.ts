import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagingSurfaceIntent } from "@pwragent/messaging-interface";
import { messagingCanonicalQueueHarness } from "./fixtures/messaging-canonical-queue-harness";
import { messagingModules } from "./fixtures/messaging-controller-modules";

type Protocol = {
  channel: "telegram" | "discord";
  action: "steer" | "retry";
  delivery: "before" | "during" | "after";
  callbackSurface: boolean;
  accepted: boolean;
};

// A displayed message can receive a click before its delivery acknowledgement.
// The provider projection edits only a known message, never a callback handle.
async function runNoticeProtocol(protocol: Protocol): Promise<void> {
  const real = await messagingCanonicalQueueHarness({ channel: protocol.channel });
  const noticeEntered = Promise.withResolvers<void>();
  const noticeRelease = Promise.withResolvers<void>();
  const operationEntered = Promise.withResolvers<void>();
  const operationRelease = Promise.withResolvers<void>();
  let noticeDelivery: Promise<void> | undefined;
  let callback: Promise<void> | undefined;
  try {
    await real.controller.handleInboundEvent(real.event("active turn"));
    expect(real.starts).toHaveLength(1);
    const modules = messagingModules(real.controller);
    const entry = modules.queueRecoveries.hold({
      binding: (await real.store.getBinding("fixture-binding"))!,
      threadKey: "codex:fixture-thread", preview: "retained input",
      event: real.event("retained input"), input: [{ type: "text", text: "retained input" }],
    })!;
    const surface = { channel: protocol.channel, id: "fixture-recovery-message" };
    const messages = new Map<string, string[]>();
    const retirements: MessagingSurfaceIntent[] = [];
    const deliver = real.controllerOptions.adapter.deliver.bind(real.controllerOptions.adapter);
    real.controllerOptions.adapter.deliver = async intent => {
      const result = await deliver(intent);
      if (intent.kind === "confirmation" && intent.actions?.some(action => action.id === `queued-turn:retry:${entry.id}`)) {
        messages.set(surface.id, intent.actions.map(action => action.id));
        noticeEntered.resolve();
        await noticeRelease.promise;
        return { ...result, surface };
      }
      // Recognize retirement by the delivery contract, independently of copy.
      if (intent.kind === "confirmation" && intent.delivery?.mode === "update" && intent.delivery.replaceMarkup) {
        retirements.push(intent);
        if (intent.targetSurface && messages.has(intent.targetSurface.id)) {
          messages.set(intent.targetSurface.id, intent.actions?.map(action => action.id) ?? []);
        }
      }
      return result;
    };
    noticeDelivery = modules.callbackHost().deliverQueuedTurnNotice(entry);
    await noticeEntered.promise;
    expect(messages.get(surface.id)).toHaveLength(3);
    if (protocol.delivery === "before") {
      noticeRelease.resolve();
      await noticeDelivery;
    }
    const operation = async () => {
      operationEntered.resolve();
      await operationRelease.promise;
      if (!protocol.accepted) throw new Error("Fixture recovery refused");
    };
    if (protocol.action === "steer") real.queueHooks.steer = operation;
    else real.queueHooks.admit = operation;
    callback = real.controller.handleInboundEvent({
      ...real.callback(`queued-turn:${protocol.action}:${entry.id}`),
      // Before an acknowledgement, the click itself still identifies the
      // already displayed message. Older adapters may omit this field.
      sourceSurface: protocol.callbackSurface || protocol.delivery === "after" ? surface : undefined,
    });
    await operationEntered.promise;
    if (protocol.delivery === "during") {
      noticeRelease.resolve();
      await noticeDelivery;
    }
    operationRelease.resolve();
    await callback;
    await real.controller.whenQueuedTurnActionsSettled();
    if (protocol.accepted) {
      expect(retirements.map(intent => intent.targetSurface)).toEqual([surface]);
      expect(retirements[0]?.delivery).toMatchObject({ mode: "update", replaceMarkup: true });
      expect(messages.get(surface.id)).toEqual([]);
      expect(modules.queueRecoveries.size).toBe(0);
      if (protocol.action === "steer") {
        expect(retirements[0]).toMatchObject({ title: "Message steered", body: "Sent to the current turn." });
        expect(real.steers.at(-1)?.input).toEqual(entry.input);
      } else {
        expect(retirements[0]).toMatchObject({ title: "Message queued", body: "Queued message handed to the thread queue." });
        expect(real.queued().map(row => row.input)).toEqual([entry.input]);
      }
    } else {
      expect(retirements).toEqual([]);
      expect(messages.get(surface.id)).toHaveLength(3);
      expect(modules.queueRecoveries.get(entry.id)?.input).toEqual(entry.input);
    }
    if (protocol.delivery === "after") {
      noticeRelease.resolve();
      await noticeDelivery;
    }
    expect(modules.queueRecoveries.size).toBe(protocol.accepted ? 0 : 1);
  } finally {
    noticeRelease.resolve();
    operationRelease.resolve();
    await noticeDelivery;
    await callback;
    await real.close();
  }
}

describe("recovery notice delivery and action protocol", () => {
  it("retires the original notice when its surface arrives during Steer", async () => {
    await runNoticeProtocol({ channel: "telegram", action: "steer", delivery: "during", callbackSurface: false, accepted: true });
  });

  it("retires the original notice when its surface arrives during Retry", async () => {
    await runNoticeProtocol({ channel: "telegram", action: "retry", delivery: "during", callbackSurface: false, accepted: true });
  });

  it("uses the clicked message while its delivery acknowledgement is still pending", async () => {
    for (const action of ["steer", "retry"] as const) {
      await runNoticeProtocol({ channel: "telegram", action, delivery: "after", callbackSurface: true, accepted: true });
    }
  });

  it("edits the displayed notice after acceptance and preserves its actions after refusal across acknowledgement orders", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom<Protocol["channel"]>("telegram", "discord"),
      fc.constantFrom<Protocol["action"]>("steer", "retry"),
      fc.constantFrom<Protocol["delivery"]>("before", "during", "after"), fc.boolean(), fc.boolean(),
      async (channel, action, delivery, callbackSurface, accepted) => {
        await runNoticeProtocol({ channel, action, delivery, callbackSurface, accepted });
      },
    ), { numRuns: 25 });
  });
});
