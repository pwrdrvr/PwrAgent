import { randomUUID } from "node:crypto";
import type {
  MessagingBindingRecord, MessagingDeliveryResult, MessagingInboundCallbackEvent,
  MessagingSurfaceAction, MessagingSurfaceRef,
} from "@pwragent/messaging-interface";
import type { AppUpdateRestartReceipt } from "@pwragent/owner-core/app-update-notice-storage";
import { getMainLogger } from "../log";
import { buildMessagingConversationKey } from "./core/messaging-store";
import { isAcceptedDeliveryOutcome } from "./core/messaging-reply-receipts";

const log = getMainLogger("pwragent:app-update-controls");
const ACTION_PREFIX = "app-update:";
const MAX_CARDS = 256;
const CHECK_IDLE_INTERVAL_MS = 2_000;
const PROGRESS_UPDATE_INTERVAL_MS = 30_000;
const MAX_PROGRESS_EDITS = 12;
const CONFIRMATION_TTL_MS = 5 * 60_000;

type Target = Readonly<{ version: string; selection: string }>;
type Phase = "ready" | "confirm" | "waiting" | "starting" | "dismissed" | "closed";
type Presentation = {
  title: string;
  body: string;
  actions: MessagingSurfaceAction[];
  surface?: MessagingSurfaceRef;
};
type Card = {
  key: string;
  target: Target;
  binding: MessagingBindingRecord;
  connectionId: string;
  text: string;
  phase: Phase;
  render(presentation: Presentation): Promise<MessagingDeliveryResult>;
  nonce?: string;
  surface?: MessagingSurfaceRef;
  confirmation?: { actor: string; expiresAt: number };
  rendered?: string;
  nextRender?: symbol;
  queue: Promise<unknown>;
};
type Operation = {
  card: Card;
  phase: "waiting" | "starting" | "committed";
  isLive(): boolean;
  authorize(): Promise<boolean>;
  nextProgressAt: number;
  remainingProgressEdits: number;
  reportedBlockers: number;
};

export function isAppUpdateCallback(event: MessagingInboundCallbackEvent): boolean {
  return event.actionId?.startsWith(ACTION_PREFIX) === true;
}

export type AppUpdateCardSurface = { connectionId: string; surface: MessagingSurfaceRef };
export type AppUpdateNoticeDeliveryResult = MessagingDeliveryResult & { card?: AppUpdateCardSurface };
export type ReadyAppUpdateNotice = { version: string; restore?: true; previousCard?: AppUpdateCardSurface };

export class MessagingAppUpdateControls {
  private readonly cards = new Map<string, Card>();
  private readonly tokens = new Map<string, Card>();
  private pending?: Operation;
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly options: {
    runtimeId: string;
    readTarget(): Target | undefined;
    blockerCount(): number;
    install(request: {
      target: Target;
      authorize: () => Promise<boolean>;
      beforeHandoff: () => boolean;
    }): Promise<"accepted" | "busy" | "refused">;
    saveReceipt(receipt: AppUpdateRestartReceipt): boolean;
    clearReceipt(receipt: AppUpdateRestartReceipt): void;
  }) {}

  hasCard(binding: MessagingBindingRecord, version: string, connectionId: string): boolean {
    const card = this.cards.get(buildMessagingConversationKey(binding.channel));
    return card?.target.version === version && card.binding.id === binding.id
      && card.connectionId === connectionId && card.surface !== undefined && card.rendered !== undefined;
  }

  present(binding: MessagingBindingRecord, version: string, text: string, connectionId: string, render: Card["render"], surface?: MessagingSurfaceRef): Promise<MessagingDeliveryResult> | undefined {
    const target = this.options.readTarget();
    if (this.disposed || !target || target.version !== version) return undefined;
    const key = buildMessagingConversationKey(binding.channel);
    this.forgetCard(this.cards.get(key));
    if (this.cards.size >= MAX_CARDS) this.forgetCard(this.cards.values().next().value);
    const card: Card = { key, target: { ...target }, binding, connectionId, text, render, surface, phase: "ready", queue: Promise.resolve() };
    this.cards.set(key, card);
    const pending = this.pending;
    return this.render(card, pending && sameTarget(target, pending.card.target) ? "waiting" : "ready");
  }

  async handle(
    event: MessagingInboundCallbackEvent,
    connectionId: string | undefined,
    isLive: () => boolean,
    authorize: (binding: MessagingBindingRecord) => Promise<boolean>,
    reply: (text: string) => Promise<unknown>,
  ): Promise<void> {
    const card = typeof event.value === "string" ? this.tokens.get(event.value) : undefined;
    if (!card || this.disposed || card.connectionId !== connectionId || card.key !== buildMessagingConversationKey(event.channel)
      || !event.sourceSurface || card.surface?.id !== event.sourceSurface.id
      || card.surface.channel !== event.sourceSurface.channel) {
      await reply("This PwrAgent update card has expired. Use the latest update notice or Settings → Updates.");
      return;
    }
    const current = () => !this.disposed && isLive() && this.cards.get(card.key) === card;
    const permitted = async () => {
      try { return current() && await authorize(card.binding) && current(); }
      catch { return false; }
    };
    if (!await permitted()) {
      await reply("Your messaging account is not authorized to manage updates on this PwrAgent instance.");
      return;
    }
    if (card.nonce !== event.value) return;
    if (!sameTarget(card.target, this.options.readTarget())) {
      await this.render(card, "closed", "The staged update changed. Use the latest update notice or Settings → Updates.");
      return;
    }
    switch (event.actionId) {
      case `${ACTION_PREFIX}review`:
        if (card.phase !== "ready") return;
        if (this.pending) {
          await reply("This PwrAgent instance already has a pending update request.");
          return;
        }
        await this.render(card, "confirm", undefined,
          { actor: event.actor.platformUserId, expiresAt: Date.now() + CONFIRMATION_TTL_MS });
        return;
      case `${ACTION_PREFIX}dismiss`:
        if (card.phase === "ready" || card.phase === "confirm") await this.render(card, "dismissed");
        return;
      case `${ACTION_PREFIX}confirm`:
        if (card.phase !== "confirm" || this.pending) return;
        if (card.confirmation?.actor !== event.actor.platformUserId || card.confirmation.expiresAt <= Date.now()) {
          await reply("This confirmation belongs to another account or has expired. Open a new confirmation from the update notice.");
          if (card.confirmation && card.confirmation.expiresAt <= Date.now()) await this.render(card, "ready");
          return;
        }
        const operation: Operation = {
          card, phase: "waiting", isLive: current, authorize: permitted,
          nextProgressAt: Date.now() + PROGRESS_UPDATE_INTERVAL_MS,
          remainingProgressEdits: MAX_PROGRESS_EDITS, reportedBlockers: this.options.blockerCount(),
        };
        this.pending = operation;
        if (!await this.updateCards(operation, "waiting")) {
          await this.finish(operation, "The install request could not be acknowledged. Try again or use Settings → Updates.");
          return;
        }
        this.schedule(0);
        return;
      case `${ACTION_PREFIX}cancel`:
        if (card.phase === "waiting" && this.pending && this.pending.phase !== "committed"
          && sameTarget(card.target, this.pending.card.target)) {
          await this.finish(this.pending, "Install canceled. PwrAgent will keep running.");
        }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.pending = undefined;
    clearTimeout(this.timer);
    this.cards.clear();
    this.tokens.clear();
  }

  private forgetCard(card: Card | undefined): void {
    if (!card) return;
    if (card.nonce) this.tokens.delete(card.nonce);
    this.cards.delete(card.key);
  }

  private schedule(delay = CHECK_IDLE_INTERVAL_MS): void {
    if (this.disposed || this.pending?.phase !== "waiting" || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.advance().catch((error: unknown) => {
        log.warn("messaging app update request failed", { message: String(error) });
        if (this.pending?.phase !== "committed" && this.pending) {
          void this.finish(this.pending, "PwrAgent could not restart. Try again or use Settings → Updates.")
            .catch((deliveryError: unknown) => log.warn("messaging app update outcome could not be posted", { message: String(deliveryError) }));
        }
      });
    }, delay);
    this.timer.unref();
  }

  private async advance(): Promise<void> {
    const operation = this.pending;
    if (!operation || operation.phase !== "waiting" || this.disposed) return;
    if (!operation.isLive()) {
      await this.finish(operation, "The messaging connection changed. Open a new confirmation from the latest notice.");
      return;
    }
    if (!sameTarget(operation.card.target, this.options.readTarget())) {
      await this.finish(operation, "The staged update changed. Use the latest update notice.", "closed");
      return;
    }
    const blockers = this.options.blockerCount();
    if (blockers > 0) {
      if (operation.remainingProgressEdits > 0 && blockers !== operation.reportedBlockers
        && Date.now() >= operation.nextProgressAt) {
        operation.nextProgressAt = Date.now() + PROGRESS_UPDATE_INTERVAL_MS;
        operation.remainingProgressEdits -= 1;
        operation.reportedBlockers = blockers;
        await this.render(operation.card, "waiting", operation.remainingProgressEdits === 0
          ? "PwrAgent is still waiting for work to finish and open terminals to close. You can keep working or cancel this install."
          : undefined);
      }
      this.schedule();
      return;
    }
    operation.phase = "starting";
    if (!await this.updateCards(operation, "starting")) {
      await this.finish(operation, "The restart could not be acknowledged. Try again or use Settings → Updates.");
      return;
    }
    if (this.pending !== operation || this.disposed) return;
    const receipt: AppUpdateRestartReceipt = {
      runtimeId: this.options.runtimeId, version: operation.card.target.version,
      bindingId: operation.card.binding.id, destination: operation.card.key,
      backend: operation.card.binding.backend, threadId: operation.card.binding.threadId,
      connectionId: operation.card.connectionId,
    };
    const result = await this.options.install({
      target: operation.card.target,
      authorize: async () => this.pending === operation && !this.disposed && await operation.authorize()
        && this.pending === operation && !this.disposed,
      beforeHandoff: () => {
        if (!this.options.saveReceipt(receipt)) return false;
        operation.phase = "committed";
        return true;
      },
    });
    if (result === "accepted") return;
    if (operation.phase as Operation["phase"] === "committed") this.options.clearReceipt(receipt);
    if (result === "busy" && this.pending === operation) {
      operation.phase = "waiting";
      await this.updateCards(operation, "waiting");
      this.schedule();
      return;
    }
    await this.finish(operation, "PwrAgent could not restart. Try again or use Settings → Updates.");
  }

  private async finish(operation: Operation, message: string, phase: "ready" | "closed" = "ready"): Promise<void> {
    if (this.pending !== operation) return;
    this.pending = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.updateCards(operation, phase, message);
  }

  private async updateCards(operation: Operation, phase: Phase, message?: string): Promise<boolean> {
    const updates = await Promise.allSettled([...this.cards.values()]
      .filter((card) => sameTarget(card.target, operation.card.target) && card.phase !== "dismissed")
      .map(async (card) => {
        const result = await this.render(card, phase, message);
        return card === operation.card && isAcceptedDeliveryOutcome(result.outcome);
      }));
    return updates.some((update) => update.status === "fulfilled" && update.value);
  }

  private render(card: Card, phase: Phase, message?: string, confirmation?: Card["confirmation"]): Promise<MessagingDeliveryResult> {
    const [readyTitle, ...lines] = card.text.split("\n");
    const title = phase === "confirm" ? `Confirm PwrAgent update · v${card.target.version}`
      : phase === "waiting" ? `PwrAgent update waiting · v${card.target.version}`
        : phase === "starting" ? `PwrAgent update preparing · v${card.target.version}` : readyTitle;
    const blockers = phase === "confirm" || phase === "waiting" ? this.options.blockerCount() : 0;
    const work = blockers === 1 ? "1 blocker (active work, queued work, or an open terminal)"
      : `${blockers} blockers (active work, queued work, or open terminals)`;
    const detail = message ?? (phase === "confirm"
      ? (blockers ? `PwrAgent will wait for ${work} before installing.` : "PwrAgent will install the update and restart when work is idle.")
      : phase === "waiting"
        ? (blockers ? `Waiting for ${work}. You can keep working or cancel this install.` : "Waiting for the final idle check.")
        : phase === "starting" ? "Preparing to restart. PwrAgent will check for new work before installing." : "");
    const body = [...lines, detail].filter(Boolean).join("\n");
    const stamp = JSON.stringify([phase, body]);
    const attempt = Symbol();
    card.nextRender = attempt;
    const nonce = randomUUID();
    const action = (id: string, label: string, style: MessagingSurfaceAction["style"]): MessagingSurfaceAction => ({
      id: `${ACTION_PREFIX}${id}`, label, value: nonce, style,
    });
    const actions = phase === "ready" ? [action("review", "Install and restart", "primary"), action("dismiss", "Not now", "secondary")]
      : phase === "confirm" ? [action("confirm", blockers ? "Install when idle" : "Install now", "primary"), action("dismiss", "Not now", "secondary")]
      : phase === "waiting" ? [action("cancel", "Cancel install", "secondary")] : [];
    const delivery = card.queue.then(async () => {
      if (this.disposed || this.cards.get(card.key) !== card || card.nextRender !== attempt) {
        return { outcome: "discarded", channel: card.binding.channel.channel, deliveredAt: Date.now() } satisfies MessagingDeliveryResult;
      }
      if (stamp === card.rendered && phase === card.phase && card.surface && !confirmation) return {
        outcome: "updated", channel: card.surface.channel, surface: card.surface, deliveredAt: Date.now(),
      } satisfies MessagingDeliveryResult;
      const result = await card.render({ title: title ?? "PwrAgent update", body, actions, surface: card.surface });
      if (isAcceptedDeliveryOutcome(result.outcome) && !this.disposed && this.cards.get(card.key) === card) {
        if (card.nonce) this.tokens.delete(card.nonce);
        card.nonce = undefined;
        card.surface = result.surface ?? card.surface;
        card.phase = phase;
        card.confirmation = confirmation;
        card.rendered = stamp;
        if (actions.length && card.surface) {
          card.nonce = nonce;
          this.tokens.set(nonce, card);
        }
      }
      return result;
    });
    card.queue = delivery.catch(() => undefined);
    return delivery;
  }
}

export function sameTarget(target: Target, current: Target | undefined): boolean {
  return target.version === current?.version && target.selection === current.selection;
}
