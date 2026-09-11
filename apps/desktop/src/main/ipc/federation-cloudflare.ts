import { dialog, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import type { CloudflareSetupRequest, CloudflareSetupStatus } from "@pwragent/shared";
import { FEDERATION_CLOUDFLARE_SETUP_CHANNEL } from "../../shared/ipc";
import { CloudflareSetupService } from "../federation/cloudflare-setup-service";
import { loadCloudflareSetup, saveCloudflareSetup } from "../federation/cloudflare-setup-storage";
import { cloudflareConnector } from "../federation/cloudflare-connector";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { decryptCloudflareBundle, encryptCloudflareBundle } from "../federation/cloudflare-client-bundle";
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
        case "connect": await setup.connect(request.token, request.accountId, request.zoneId); break;
        case "disconnect": setup.disconnect(); break;
        case "provision":
          // The renderer has saved the listener config; wait for runtime ownership
          // instead of racing the asynchronous settings-change subscription.
          await getDesktopFederationRuntime().restart();
          await setup.provision(request.hostname, request.listenPort);
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
          await fs.writeFile(destination.filePath, await encryptCloudflareBundle({ version: 1, endpoint, invite, certificate: client.certificate, privateKey: client.privateKey }, request.password), { mode: 0o600 });
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
          try {
            const certificate = await settings.replaceSecret("federationCloudflareClientCertificate", bundle.certificate);
            const key = await settings.replaceSecret("federationCloudflareClientPrivateKey", bundle.privateKey);
            if (!certificate.configured || !key.configured) throw new Error("Client credentials could not be stored.");
          } catch {
            if (previous.clientCertificate) await settings.replaceSecret("federationCloudflareClientCertificate", previous.clientCertificate);
            else await settings.clearSecret("federationCloudflareClientCertificate");
            if (previous.clientPrivateKey) await settings.replaceSecret("federationCloudflareClientPrivateKey", previous.clientPrivateKey);
            else await settings.clearSecret("federationCloudflareClientPrivateKey");
            throw new Error("Client credentials could not be stored; previous credentials were restored.");
          }
          await settings.writeConfigPatchTargeted({ federation: { cloudflareEndpoint: bundle.endpoint, cloudflareMtlsEnabled: true, cloudflareAccessServiceAuthEnabled: false } });
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
