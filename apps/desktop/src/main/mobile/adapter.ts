import { randomUUID } from "node:crypto";
import type { AppServerBackendKind, FederationEventSubscription, NavigationQueryRequest, SubmitDurableSteerRequest, SubmitDurableTurnRequest } from "@pwragent/shared";
import type { MobileMachine, MobilePage, MobileScope, MobileTarget } from "../../../../../packages/shared/src/mobile-gateway";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getNativeVoiceSessions } from "../native-voice/session-owner";
import { openVoiceManagerThread } from "../native-voice/voice-manager-thread";
import type { MobileDevice } from "./device-store";
import type { MobileGatewayAdapter } from "./server";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 200): string {
  if (typeof value !== "string" || !value || value.length > max) throw new Error("Invalid request field");
  return value;
}
function requireScope(device: MobileDevice, scope: MobileScope): void {
  if (!device.scopes.includes(scope)) throw new Error(`Device lacks ${scope} permission`);
}
function authorize(device: MobileDevice, target: MobileTarget): void {
  if (device.machines !== "all" && !device.machines.includes(target.instanceId)) throw new Error("Machine outside device grant");
}
function target(value: unknown): MobileTarget {
  const data = object(value);
  return { instanceId: string(data.instanceId), backend: string(data.backend) as AppServerBackendKind, threadId: string(data.threadId) };
}
export function createMobileAdapter(): MobileGatewayAdapter {
  const federation = getDesktopFederationRuntime();
  const registry = getDesktopBackendRegistry();
  const gatewayId = federation.localFederationInstanceId();
  const voice = getNativeVoiceSessions();
  const leases = new Map<number, ReturnType<typeof setTimeout>>();
  const voiceAttempts = new Map<number, symbol>();
  const stopVoice = async (owner: number) => {
    const stopping = Symbol("stopping"); voiceAttempts.set(owner, stopping);
    clearTimeout(leases.get(owner)); leases.delete(owner);
    try {
      await voice.stopOwner(owner);
      if (voiceAttempts.get(owner) === stopping) voiceAttempts.delete(owner);
    } catch (error) {
      // A failed stop may still be billed. Retain admission ownership and retry
      // cancellation even after the phone/socket is gone.
      if (voiceAttempts.get(owner) === stopping) leases.set(owner, setTimeout(() => { void stopVoice(owner).catch(() => undefined); }, 5000));
      throw error;
    }
  };
  const machines = async (device: MobileDevice): Promise<MobileMachine[]> => {
    const health = await federation.health();
    const connected = federation.connectedPeerTargets();
    const rows: MobileMachine[] = [
      { id: gatewayId, label: health.localLabel || "Gateway", available: true, canSend: device.scopes.includes("send"), canSteer: device.scopes.includes("send") },
      ...connected.map((peer) => ({ id: peer.target.instanceId, label: peer.label, available: true, canSend: device.scopes.includes("send") && peer.capabilities.includes("durable_turn_requests_v1") && peer.capabilities.includes("turn_control"), canSteer: device.scopes.includes("send") && peer.capabilities.includes("durable_steer_requests_v1") && peer.capabilities.includes("turn_control") })),
    ];
    // Health includes remembered peers that are currently unreachable.
    for (const peer of health.peers) {
      if (!rows.some((row) => row.id === peer.id)) rows.push({ id: peer.id, label: peer.label, available: false, canSend: false });
    }
    return rows.filter((row) => device.machines === "all" || device.machines.includes(row.id));
  };
  return {
    gatewayId,
    async request(device, owner, method, raw, emit) {
      requireScope(device, "read");
      const params = object(raw);
      if (method === "hello") {
        return { protocol: 1, gatewayId, deviceId: device.id, scopes: device.scopes, machines: await machines(device), capabilities: ["thread_pages_v1", "durable_turn_requests_v1", "durable_steer_requests_v1", "live_codex_webrtc_v1"] };
      }
      if (method === "threads") {
        const query = typeof params.query === "string" ? params.query.slice(0, 200) : "";
        const cursors = params.cursors ? object(params.cursors) : undefined;
        const selected = typeof params.machine === "string" ? params.machine : undefined;
        const machineRows = await machines(device);
        const page: MobilePage = { machines: machineRows, threads: [], cursors: {}, errors: {} };
        await Promise.all(machineRows.filter((row) => !selected || row.id === selected).map(async (machine) => {
          if (cursors && !(machine.id in cursors)) return;
          try {
            if (!machine.available) throw new Error("Machine unavailable");
            const request: NavigationQueryRequest = { protocol: 2, consumer: "remote-window", backend: "all", query: query ? { kind: "search", text: query } : { kind: "lens", lens: "recents" }, pageSize: 30,
              ...(typeof cursors?.[machine.id] === "string" ? { cursor: cursors[machine.id] as string } : {}) };
            const result = machine.id === gatewayId
              ? await federation.localBackend().getNavigationQueryPage!(request, { requesterInstanceId: `mobile:${device.id}` })
              : await federation.remoteNavigationQueryPage({ scope: "remote", instanceId: machine.id }, request);
            for (const entry of result.entries) page.threads.push({ target: { instanceId: machine.id, backend: entry.row.ref.backend, threadId: entry.row.ref.threadId }, machineLabel: machine.label, row: entry.row });
            if (result.nextCursor) page.cursors[machine.id] = result.nextCursor;
            if (result.coverage.state !== "complete") page.errors[machine.id] = "Some providers are unavailable or still loading";
          } catch (error) { page.errors[machine.id] = error instanceof Error ? error.message : "Machine unavailable"; }
        }));
        page.threads.sort((a, b) => (b.row.updatedAt ?? 0) - (a.row.updatedAt ?? 0));
        return page;
      }
      if (method === "thread") {
        const ref = target(params.target); authorize(device, ref);
        const backend = ref.instanceId === gatewayId ? federation.localBackend() : federation.remoteBackend({ scope: "remote", instanceId: ref.instanceId });
        const response = await backend.readThread({ backend: ref.backend, threadId: ref.threadId, includeTurns: true, viewOnly: true, limit: 50, ...(typeof params.before === "string" ? { before: params.before } : {}) });
        return { target: ref, response };
      }
      if (["turn.submit", "turn.get", "steer.submit", "steer.get"].includes(method)) {
        const steer = method.startsWith("steer.");
        requireScope(device, "send");
        const ref = target(params.target); authorize(device, ref);
        const remote = ref.instanceId === gatewayId ? undefined : { scope: "remote" as const, instanceId: ref.instanceId };
        const scope = `mobile:${device.id}`;
        if (method.endsWith(".get")) {
          const lookup = { id: string(params.id, 80), backend: ref.backend, threadId: ref.threadId };
          return steer ? federation.getDurableSteerRequest(scope, lookup, remote) : federation.getDurableTurnRequest(scope, lookup, remote);
        }
        const submission = object(params.submission);
        const request = object(submission.request);
        // Mobile v1 grants text submission, not arbitrary execution settings,
        // attachment paths, forged message origin, or caller-supplied routing.
        if (request.backend !== ref.backend || request.threadId !== ref.threadId
          || Object.keys(request).some((key) => !(steer ? ["backend", "threadId", "input", "expectedTurnId"] : ["backend", "threadId", "input"]).includes(key))
          || !Array.isArray(request.input) || request.input.length !== 1) throw new Error("Invalid mobile prompt");
        const input = object(request.input[0]);
        if (input.type !== "text" || Object.keys(input).some((key) => !["type", "text"].includes(key))) throw new Error("Invalid mobile prompt");
        string(input.text, 16_000);
        if (steer) {
          string(request.expectedTurnId);
          return federation.submitDurableSteerRequest(scope, submission as SubmitDurableSteerRequest, remote);
        }
        return federation.submitDurableTurnRequest(scope, submission as SubmitDurableTurnRequest, remote);
      }
      if (method === "voice.start") {
        requireScope(device, "voice"); requireScope(device, "send");
        // The existing director tools can reach all machines. A restricted
        // device must never inherit that broader tool authority.
        if (device.machines !== "all") throw new Error("Live requires an all-machines controller grant");
        const sessionId = string(params.sessionId, 80); const sdp = string(params.sdp, 100_000);
        if (!sdp.startsWith("v=0")) throw new Error("Invalid voice offer");
        if (voiceAttempts.has(owner)) throw new Error("Live already starting or open");
        const attempt = Symbol(); voiceAttempts.set(owner, attempt);
        leases.set(owner, setTimeout(() => { void stopVoice(owner).catch(() => undefined); }, 10 * 60_000));
        try {
          const capability = await registry.nativeVoiceCapability();
          if (voiceAttempts.get(owner) !== attempt) throw new Error("Live cancelled");
          if (!capability.available) throw new Error(capability.reason ?? "Live unavailable");
          const manager = await openVoiceManagerThread();
          if (voiceAttempts.get(owner) !== attempt) throw new Error("Live cancelled");
          if (manager.status !== "ready") throw new Error(manager.error);
          await voice.start(owner, { sessionId, sdp, threadId: manager.threadId, mode: "director" }, (data) => emit({ event: "voice", data }));
          if (voiceAttempts.get(owner) !== attempt) await voice.stopOwner(owner);
        } catch (error) {
          if (voiceAttempts.get(owner) === attempt) await stopVoice(owner);
          throw error;
        }
        return {};
      }
      if (method === "voice.stop") { await stopVoice(owner); return {}; }
      throw new Error("Gateway capability unavailable");
    },
    async disconnected(owner) { await stopVoice(owner); },
    subscribe(device, emit) {
      const consumer = `mobile:${device.id}:${randomUUID()}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const changed = () => { if (!timer) timer = setTimeout(() => { timer = undefined; emit({ event: "changed" }); }, 150); };
      const update = () => {
        const subscriptions: FederationEventSubscription[] = federation.connectedPeerTargets()
          .filter((peer) => device.machines === "all" || device.machines.includes(peer.target.instanceId))
          .map((peer) => ({ sourceInstanceId: peer.target.instanceId, eventClasses: ["navigation", "transcript"], threadSelection: { kind: "all" } }));
        federation.setEventSubscriptions(consumer, subscriptions); changed();
      };
      update();
      const off = [registry.onEvent(changed), federation.onRemoteBackendEvent(changed), federation.onPeerStatusChanged(update)];
      return () => { clearTimeout(timer); off.forEach((dispose) => dispose()); federation.setEventSubscriptions(consumer, []); };
    },
  };
}
