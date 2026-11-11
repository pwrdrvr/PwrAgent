import path from "node:path";
import fs from "node:fs";
import type { FederationPeerRole, SubmitDurableTurnRequest } from "@pwragent/shared";
import { ensureNamedProfileExists } from "../profile";
import type { startOwnerServices } from "../owner-services";

type Services = Awaited<ReturnType<typeof startOwnerServices>>;

/** Only creates the private directories. The root claims ownership before configuring them. */
export async function prepareOutpostProfile(profile: string): Promise<void> {
  const { profileDir } = ensureNamedProfileExists(profile);
  fs.mkdirSync(path.join(profileDir, "state"), { recursive: true, mode: 0o700 });
  fs.chmodSync(profileDir, 0o700);
  fs.chmodSync(path.join(profileDir, "state"), 0o700);
}

/** Local operator transport: the same owner methods used by IPC and federation. */
export async function handleOutpostCommand(services: Services, method: string, params: Record<string, unknown>): Promise<unknown> {
  const { registry, federationRuntime: federation, settings } = services;
  switch (method) {
    case "status": return { codex: await settings.resolveCodexCommand(), backends: await registry.listBackends(), federation: await federation.health() };
    case "list": return registry.listThreads({ backend: "codex", callerReason: "outpost-cli", enrichDirectories: false, ...params });
    case "show": return registry.readThread(params as Parameters<typeof registry.readThread>[0]);
    case "start-thread": return registry.startThread(params as Parameters<typeof registry.startThread>[0]);
    case "submit": return federation.submitDurableTurnRequest("local-cli", params as unknown as SubmitDurableTurnRequest);
    case "receipt": return federation.getDurableTurnRequest("local-cli", params as Parameters<typeof federation.getDurableTurnRequest>[1]);
    case "pause":
    case "resume": return registry.setQueuedTurnPaused({ queueEntryId: String(params.queueEntryId), paused: method === "pause" });
    case "move": return registry.moveQueuedTurn({ queueEntryId: String(params.queueEntryId), beforeQueueEntryId: params.beforeQueueEntryId as string | undefined });
    case "cancel": return registry.cancelQueuedTurnWithDisposition(String(params.queueEntryId));
    case "release": return registry.releaseQueuedTurnWithDisposition(String(params.queueEntryId));
    case "interrupt": return registry.controlActiveTurn(params as Parameters<typeof registry.controlActiveTurn>[0]);
    case "federation-status": return federation.health();
    case "federation-join": return federation.importInvite(String(params.invite));
    case "federation-revoke": return federation.revokePeer(String(params.peer));
    case "federation-invite": {
      const current = settings.readFederationConfig();
      const listening = current.mode === "gateway" || current.mode === "dual";
      const requested = params.port === undefined ? undefined : Number(params.port);
      if (requested !== undefined && (!Number.isInteger(requested) || requested < 1 || requested > 65535)) {
        throw new Error("Invalid gateway port.");
      }
      // Without a port, an already-listening gateway keeps its configured
      // port, including `listen_port = 0`, and the invite names the port
      // the listener holds.
      const port = requested ?? (listening ? current.listenPort : 47831);
      if (!listening || current.listenPort !== port) {
        const patch = { federation: { mode: current.mode === "client" || current.mode === "dual" ? "dual" as const : "gateway" as const,
          listenHost: "127.0.0.1", listenPort: port } };
        await settings.writeConfigPatchTargeted(patch);
        await services.onConfigPatchWritten(patch);
      } else {
        // Startup begins the listener without awaiting it.
        await federation.whenRestartSettled();
      }
      return federation.generateInvite({ label: params.label as string | undefined, permissionRole: "full" as FederationPeerRole });
    }
    case "federation-leave":
      await settings.writeConfigPatchTargeted({ federation: { mode: "disabled" } });
      await services.onConfigPatchWritten({ federation: { mode: "disabled" } });
      return { left: true };
    default: throw new Error(`Unknown Outpost command: ${method}`);
  }
}
