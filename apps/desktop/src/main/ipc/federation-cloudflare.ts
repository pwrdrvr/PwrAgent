import { dialog, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import type { CloudflareSetupLink, CloudflareSetupRequest, CloudflareSetupStatus } from "@pwragent/shared";
import { FEDERATION_CLOUDFLARE_SETUP_CHANNEL } from "../../shared/ipc";
import { CloudflareSetupService, cloudflareSetupGate } from "../federation/cloudflare-setup-service";
import { loadCloudflareSetup, saveCloudflareSetup } from "../federation/cloudflare-setup-storage";
import { cloudflareConnector } from "../federation/cloudflare-connector";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { bundleGate, decryptCloudflareBundle, encryptCloudflareBundle } from "../federation/cloudflare-client-bundle";
import { decodeFederationInvite, encodeFederationInvite } from "../federation/federation-enrollment";

const setup = new CloudflareSetupService({
  load: loadCloudflareSetup,
  save: saveCloudflareSetup,
  verifyListener: (port) => getDesktopFederationRuntime().cloudflareSecurityProbes(port),
  connectorInstalled: () => cloudflareConnector.installed(),
  connectorRunning: () => cloudflareConnector.running(),
  startConnector: (token) => cloudflareConnector.start(token),
  stopConnector: () => cloudflareConnector.stop(),
  publishUrl: async (url) => {
    await getDesktopSettingsService().writeConfigPatchTargeted({ federation: { publicUrl: url } });
    await getDesktopFederationRuntime().restart();
  },
});

/**
 * Fixed reference table for `open-link`.
 *
 * `:account` and `:zone` are the only interpolation, filled from setup state, so
 * an operator lands on their own dashboard page rather than a generic one. The
 * Zero Trust deep-link shape (`one.dash…/?to=/:account/...`) is Cloudflare's own,
 * taken from the route table their docs build `DashButton` from.
 */
const CLOUDFLARE_LINKS: Record<CloudflareSetupLink, string> = {
  "mtls-docs":
    "https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/mutual-tls-authentication/",
  // The plan comparison, not the docs availability note: that note currently
  // reads "Enterprise and pay-as-you-go", which contradicts the summary of the
  // pull request that added it ("requires a Zero Trust contract plan") and the
  // plan table's own mTLS row. Send operators to the table.
  "mtls-plans": "https://www.cloudflare.com/sase/products/access/",
  "signature-algorithms":
    "https://developers.cloudflare.com/ssl/client-certificates/byo-ca/",
  "service-token-docs":
    "https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/",
  "dash-mtls": "https://one.dash.cloudflare.com/?to=/:account/access/service-auth/mtls",
  "dash-service-tokens": "https://one.dash.cloudflare.com/?to=/:account/access/service-auth/service-tokens",
  "dash-applications": "https://one.dash.cloudflare.com/?to=/:account/access/apps",
  "dash-policies": "https://one.dash.cloudflare.com/?to=/:account/access/policies",
  "dash-tunnels": "https://one.dash.cloudflare.com/?to=/:account/access/tunnels",
  "dash-zone-overview": "https://dash.cloudflare.com/:account/:zone",
};

let busy = false;

export function registerCloudflareSetupIpc(): void {
  ipcMain.removeHandler(FEDERATION_CLOUDFLARE_SETUP_CHANNEL);
  ipcMain.handle(FEDERATION_CLOUDFLARE_SETUP_CHANNEL, async (_event, request: CloudflareSetupRequest): Promise<CloudflareSetupStatus> => {
    if (!request || typeof request !== "object") throw new Error("Invalid Cloudflare setup request.");
    if (request.action === "status") return setup.status();
    if (busy) throw new Error("A Cloudflare setup operation is already running.");
    busy = true;
    try {
      switch (request.action) {
        case "token-link": {
          const url = new URL("https://dash.cloudflare.com/profile/api-tokens");
          url.searchParams.set("permissionGroupKeys", JSON.stringify([
            { key: "dns", type: "edit" }, { key: "zone", type: "read" }, { key: "access", type: "edit" },
          ]));
          url.searchParams.set("accountId", "*");
          url.searchParams.set("zoneId", "all");
          url.searchParams.set("name", "PwrAgent Federation setup");
          await shell.openExternal(url.toString());
          break;
        }
        case "install-link":
          await shell.openExternal("https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/");
          break;
        case "open-link": {
          const template = Object.prototype.hasOwnProperty.call(CLOUDFLARE_LINKS, request.link)
            ? CLOUDFLARE_LINKS[request.link]
            : undefined;
          if (!template) throw new Error("Unknown Cloudflare reference link.");
          const state = await loadCloudflareSetup();
          const status = await setup.status();
          const accountId = state?.accountId ?? status.accountId;
          const zoneId = state?.zoneId ?? status.zoneId;
          // A dashboard deep link with an unresolved placeholder is worse than a
          // generic one: it 404s. Fall back to the dashboard root instead.
          const url = template.includes(":account") && !accountId
            ? "https://one.dash.cloudflare.com/"
            : template.replace(":account", accountId ?? "").replace(":zone", zoneId ?? "");
          await shell.openExternal(url);
          break;
        }
        case "connect": await setup.connect(request.token, request.accountId, request.zoneId); break;
        case "disconnect": setup.disconnect(); break;
        case "provision":
          // The renderer has saved the listener config; wait for runtime ownership
          // instead of racing the asynchronous settings-change subscription.
          await getDesktopFederationRuntime().restart();
          await setup.provision(request.hostname, request.listenPort, request.gate);
          break;
        case "audit": await setup.audit(); break;
        case "validate": await setup.validate(); break;
        case "start": await setup.start(); break;
        case "stop": await setup.stop(); break;
        case "revoke-client": await setup.revoke(request.id); break;
        case "export-client": {
          if (typeof request.password !== "string" || request.password.length < 12 || request.password.length > 1024) throw new Error("Use a bundle password with at least 12 characters.");
          const destination = await dialog.showSaveDialog({ title: "Save encrypted client setup", defaultPath: "pwragent-client.pwrcf", filters: [{ name: "PwrAgent client", extensions: ["pwrcf"] }] });
          if (destination.canceled || !destination.filePath) break;
          const client = await setup.issue(request.label);
          const state = await loadCloudflareSetup();
          if (!state) throw new Error("Cloudflare setup is unavailable.");
          const generated = await getDesktopFederationRuntime().generateInvite({ label: request.label });
          const endpoint = `wss://${state.hostname}`;
          const invite = encodeFederationInvite({ ...decodeFederationInvite(generated.invite), gatewayUrl: endpoint, gatewayEndpoints: [endpoint] });
          const gate = cloudflareSetupGate(state);
          await fs.writeFile(destination.filePath, await encryptCloudflareBundle({
            version: 1, gate, endpoint, invite,
            ...(gate === "service-token"
              ? { accessClientId: client.clientId, accessClientSecret: client.clientSecret }
              : { certificate: client.certificate, privateKey: client.privateKey }),
          }, request.password), { mode: 0o600 });
          return { ...await setup.status(), message: "Client setup saved. Transfer the encrypted file and share its password separately. The enrollment invite expires in one hour." };
        }
        case "import-client": {
          if (typeof request.password !== "string") throw new Error("Enter the bundle password.");
          const selected = await dialog.showOpenDialog({ title: "Open encrypted client setup", properties: ["openFile"], filters: [{ name: "PwrAgent client", extensions: ["pwrcf"] }] });
          if (selected.canceled || !selected.filePaths[0]) break;
          const file = selected.filePaths[0];
          if ((await fs.stat(file)).size > 128_000) throw new Error("Client bundle exceeds the import limit.");
          const bundle = await decryptCloudflareBundle(await fs.readFile(file, "utf8"), request.password);
          const invite = decodeFederationInvite(bundle.invite);
          if (invite.gatewayUrl !== bundle.endpoint || invite.gatewayEndpoints?.some((url) => url !== bundle.endpoint)
            || invite.expiresAt <= Date.now()) throw new Error("The client invite expired or does not match its Cloudflare endpoint.");
          const confirm = await dialog.showMessageBox({ type: "question", title: "Connect this client", message: `Connect this profile to ${new URL(bundle.endpoint).hostname}?`, detail: "This installs the client certificate and enrolls this profile with the gateway in the encrypted setup file.", buttons: ["Cancel", "Connect"], defaultId: 0, cancelId: 0 });
          if (confirm.response !== 1) break;
          const settings = getDesktopSettingsService();
          const storage = settings.readSecretStorageState();
          if (!storage.available || !storage.encrypted) throw new Error("Encrypted OS credential storage is required to import a client certificate.");
          const previous = await settings.resolveFederationCloudflareCredentials();
          const importGate = bundleGate(bundle);
          // Which two secrets this writes is the whole difference between the
          // gates on the client side; the runtime reads one pair or the other.
          const keys = importGate === "service-token"
            ? ["federationCloudflareAccessClientId", "federationCloudflareAccessClientSecret"] as const
            : ["federationCloudflareClientCertificate", "federationCloudflareClientPrivateKey"] as const;
          const values = importGate === "service-token"
            ? [bundle.accessClientId, bundle.accessClientSecret]
            : [bundle.certificate, bundle.privateKey];
          const restore = importGate === "service-token"
            ? [previous.accessClientId, previous.accessClientSecret]
            : [previous.clientCertificate, previous.clientPrivateKey];
          if (!values[0] || !values[1]) throw new Error("The client setup file is missing its credential.");
          try {
            for (const [index, key] of keys.entries()) {
              const stored = await settings.replaceSecret(key, values[index] as string);
              if (!stored.configured) throw new Error("Client credentials could not be stored.");
            }
          } catch {
            for (const [index, key] of keys.entries()) {
              if (restore[index]) await settings.replaceSecret(key, restore[index] as string);
              else await settings.clearSecret(key);
            }
            throw new Error("Client credentials could not be stored; previous credentials were restored.");
          }
          await settings.writeConfigPatchTargeted({ federation: {
            cloudflareEndpoint: bundle.endpoint,
            cloudflareMtlsEnabled: importGate === "mtls",
            cloudflareAccessServiceAuthEnabled: importGate === "service-token",
          } });
          await getDesktopFederationRuntime().restart();
          await getDesktopFederationRuntime().importInvite(bundle.invite);
          return { ...await setup.status(), message: "Client credentials installed and gateway invite imported." };
        }
        default: throw new Error("Unknown Cloudflare setup action.");
      }
      return setup.status();
    } finally { busy = false; }
  });
}
