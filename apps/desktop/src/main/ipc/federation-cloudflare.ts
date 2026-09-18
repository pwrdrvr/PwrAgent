import { dialog, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import type { CloudflareSetupLink, CloudflareSetupRequest, CloudflareSetupStatus } from "@pwragent/shared";
import { FEDERATION_CLOUDFLARE_SETUP_CHANNEL } from "../../shared/ipc";
import { CloudflareSetupService, cloudflareSetupGate, cloudflareSetupResources } from "../federation/cloudflare-setup-service";
import {
  clearCloudflareSetup,
  loadCloudflareSetup,
  loadCloudflareSetupDraft,
  saveCloudflareSetup,
  saveCloudflareSetupDraft,
} from "../federation/cloudflare-setup-storage";
import { cloudflareConnector } from "../federation/cloudflare-connector";
import { getCloudflareAccessSignIn } from "../federation/cloudflare-access-sign-in";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { bundleGate, decryptCloudflareBundle, encryptCloudflareBundle } from "../federation/cloudflare-client-bundle";
import { decodeFederationInvite, encodeFederationInvite } from "../federation/federation-enrollment";

const setup = new CloudflareSetupService({
  load: loadCloudflareSetup,
  save: saveCloudflareSetup,
  clear: clearCloudflareSetup,
  verifyListener: (port) => getDesktopFederationRuntime().cloudflareSecurityProbes(port),
  listeningPort: () => getDesktopFederationRuntime().loopbackListenPort(),
  connectorInstalled: () => cloudflareConnector.installed(),
  connectorRunning: () => cloudflareConnector.running(),
  startConnector: (token) => cloudflareConnector.start(token),
  stopConnector: () => cloudflareConnector.stop(),
  publishUrl: async (url) => {
    await getDesktopSettingsService().writeConfigPatchTargeted({ federation: { publicUrl: url } });
    await getDesktopFederationRuntime().restart();
  },
  unpublishUrl: async (url) => {
    // Only the address this setup published: an operator-set one stays.
    if (getDesktopSettingsService().readFederationConfig().publicUrl !== url) return;
    await getDesktopSettingsService().writeConfigPatchTargeted({ federation: { publicUrl: "" } });
    await getDesktopFederationRuntime().restart();
  },
  probeSignIn: (endpoint) => getCloudflareAccessSignIn().probe(endpoint),
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
  "oauth-docs":
    "https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/",
  "github-login-docs":
    "https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/",
  "dash-mtls": "https://one.dash.cloudflare.com/?to=/:account/access/service-auth/mtls",
  "dash-service-tokens": "https://one.dash.cloudflare.com/?to=/:account/access/service-auth/service-tokens",
  "dash-applications": "https://one.dash.cloudflare.com/?to=/:account/access/apps",
  "dash-policies": "https://one.dash.cloudflare.com/?to=/:account/access/policies",
  "dash-tunnels": "https://one.dash.cloudflare.com/?to=/:account/access/tunnels",
  "dash-login-methods": "https://one.dash.cloudflare.com/?to=/:account/integrations/identity-providers",
  "dash-zone-overview": "https://dash.cloudflare.com/:account/:zone",
};

let busy = false;

/**
 * The gateway setup plus what only this profile knows: the unsaved draft and,
 * when this instance connects through a sign-in endpoint, its own sign-in.
 */
async function describe(message?: string): Promise<CloudflareSetupStatus> {
  const status = await setup.status();
  const draft = await loadCloudflareSetupDraft().catch(() => undefined);
  const federation = getDesktopSettingsService().readFederationConfig();
  const endpoint = federation.cloudflareEndpoint?.trim();
  const signIn = federation.cloudflareAccessOAuthEnabled && endpoint
    ? await getCloudflareAccessSignIn().status(endpoint)
    : undefined;
  return { ...status, draft, signIn, ...(message ? { message } : {}) };
}

function signInEndpoint(): string {
  const federation = getDesktopSettingsService().readFederationConfig();
  const endpoint = federation.cloudflareEndpoint?.trim();
  if (!federation.cloudflareAccessOAuthEnabled || !endpoint) {
    throw new Error("This instance is not set up to sign in to a Cloudflare endpoint. Open a client setup file or enable Access sign-in below.");
  }
  return endpoint;
}

export function registerCloudflareSetupIpc(): void {
  ipcMain.removeHandler(FEDERATION_CLOUDFLARE_SETUP_CHANNEL);
  ipcMain.handle(FEDERATION_CLOUDFLARE_SETUP_CHANNEL, async (_event, request: CloudflareSetupRequest): Promise<CloudflareSetupStatus> => {
    if (!request || typeof request !== "object") throw new Error("Invalid Cloudflare setup request.");
    if (request.action === "status") return describe();
    // Outside the latch: it exists to release a sign-in that holds it.
    if (request.action === "cancel-sign-in") {
      getCloudflareAccessSignIn().cancel();
      return describe();
    }
    if (busy) throw new Error("A Cloudflare setup operation is already running.");
    busy = true;
    try {
      switch (request.action) {
        case "token-link": {
          const url = new URL("https://dash.cloudflare.com/profile/api-tokens");
          // `argotunnel` is Cloudflare Tunnel. Cloudflare publishes no template
          // key for Access: Service Tokens or zone-level Access apps, so the
          // setup's permission list names those for the operator to add.
          url.searchParams.set("permissionGroupKeys", JSON.stringify([
            { key: "argotunnel", type: "edit" }, { key: "access", type: "edit" },
            { key: "dns", type: "edit" }, { key: "zone", type: "read" },
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
          const state = await loadCloudflareSetup().catch(() => undefined);
          const status = await setup.status().catch(() => undefined);
          const draft = await loadCloudflareSetupDraft().catch(() => undefined);
          const accountId = state?.accountId ?? status?.accountId ?? draft?.accountId;
          const zoneId = state?.zoneId ?? status?.zoneId ?? draft?.zoneId;
          // Only a well-formed id is interpolated: a draft is unvalidated, and
          // a dashboard deep link with a bad or unresolved placeholder is worse
          // than a generic one — it 404s. Fall back to the dashboard root.
          const valid = (value: string | undefined) => value && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
          const account = valid(accountId);
          const zone = valid(zoneId);
          const url = (template.includes(":account") && !account) || (template.includes(":zone") && !zone)
            ? template.startsWith("https://dash.") ? "https://dash.cloudflare.com/" : "https://one.dash.cloudflare.com/"
            : template.replace(":account", account ?? "").replace(":zone", zone ?? "");
          await shell.openExternal(url);
          break;
        }
        case "save-draft":
          await saveCloudflareSetupDraft(request.draft);
          return describe("Draft saved. Nothing in Cloudflare or PwrAgent changes until you connect.");
        case "connect": await setup.connect(request.token, request.accountId, request.zoneId, request.gate); break;
        case "disconnect": setup.disconnect(); break;
        case "provision":
          // The renderer has saved the listener config; wait for runtime ownership
          // instead of racing the asynchronous settings-change subscription.
          await getDesktopFederationRuntime().restart();
          await setup.provision(request.hostname, request.listenPort, request.gate, request.emails);
          // The setup record now holds everything the draft did.
          await saveCloudflareSetupDraft({});
          break;
        case "remove": {
          const current = await loadCloudflareSetup();
          if (!current) throw new Error("There is no endpoint to remove.");
          const resources = cloudflareSetupResources(current);
          const published = Boolean(current.dnsId);
          const confirm = await dialog.showMessageBox({
            type: "warning",
            title: published ? "Remove endpoint" : "Start over",
            message: published ? `Remove ${current.hostname}?` : `Delete what was created for ${current.hostname}?`,
            detail: `${resources.length ? `This deletes, in Cloudflare: ${resources.join(", ")}.` : "Nothing was created in Cloudflare yet."}`
              + " Nothing else in the account is changed."
              + (published ? " Clients connected through this hostname lose access." : "")
              + " This profile's setup record is then cleared so you can start again.",
            buttons: ["Cancel", published ? "Remove endpoint" : "Start over"], defaultId: 0, cancelId: 0,
          });
          if (confirm.response !== 1) break;
          const hostname = await setup.remove();
          return describe(`${hostname} was removed from Cloudflare and this profile.`);
        }
        case "set-emails":
          await setup.setEmails(request.emails);
          return describe("Sign-in allowlist updated. Removed people lose access at their next token refresh, within 15 minutes.");
        case "audit": await setup.audit(); break;
        case "validate": await setup.validate(); break;
        case "start": await setup.start(); break;
        case "stop": await setup.stop(); break;
        case "revoke-client": await setup.revoke(request.id); break;
        case "sign-in": {
          await getCloudflareAccessSignIn().signIn(signInEndpoint());
          await getDesktopFederationRuntime().restart();
          return describe("Signed in. Federation is reconnecting.");
        }
        case "sign-out":
          await getCloudflareAccessSignIn().signOut();
          await getDesktopFederationRuntime().restart();
          return describe("Signed out of Cloudflare Access on this instance.");
        case "export-client": {
          if (typeof request.password !== "string" || request.password.length < 12 || request.password.length > 1024) throw new Error("Use a bundle password with at least 12 characters.");
          const hours = Number.isInteger(request.inviteTtlHours) ? Math.min(24, Math.max(1, request.inviteTtlHours as number)) : 1;
          const current = await loadCloudflareSetup();
          if (!current) throw new Error("Create the protected endpoint first.");
          const gate = cloudflareSetupGate(current);
          const destination = await dialog.showSaveDialog({ title: "Save encrypted client setup", defaultPath: "pwragent-client.pwrcf", filters: [{ name: "PwrAgent client", extensions: ["pwrcf"] }] });
          if (destination.canceled || !destination.filePath) break;
          // A sign-in endpoint issues no credential: the file carries the
          // endpoint and invite, and the person signs in as themselves.
          const client = gate === "oauth" ? undefined : await setup.issue(request.label);
          if (gate === "oauth") await setup.assertShareable();
          const state = await loadCloudflareSetup();
          if (!state) throw new Error("Cloudflare setup is unavailable.");
          const generated = await getDesktopFederationRuntime().generateInvite({ label: request.label, ttlMs: hours * 3_600_000 });
          const endpoint = `wss://${state.hostname}`;
          const invite = encodeFederationInvite({ ...decodeFederationInvite(generated.invite), gatewayUrl: endpoint, gatewayEndpoints: [endpoint] });
          await fs.writeFile(destination.filePath, await encryptCloudflareBundle({
            version: 1, gate, endpoint, invite,
            ...(gate === "service-token"
              ? { accessClientId: client?.clientId, accessClientSecret: client?.clientSecret }
              : gate === "mtls" ? { certificate: client?.certificate, privateKey: client?.privateKey } : {}),
          }, request.password), { mode: 0o600 });
          const expiry = hours === 1 ? "one hour" : `${hours} hours`;
          return describe(gate === "oauth"
            ? `Client setup saved. Transfer the encrypted file and share its password separately. The person signs in with an allowed email; the enrollment invite expires in ${expiry}.`
            : `Client setup saved. Transfer the encrypted file and share its password separately. The enrollment invite expires in ${expiry}.`);
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
          const importGate = bundleGate(bundle);
          const host = new URL(bundle.endpoint).hostname;
          const confirm = await dialog.showMessageBox({ type: "question", title: "Connect this client", message: `Connect this profile to ${host}?`,
            detail: importGate === "oauth"
              ? "Your browser opens to sign in to Cloudflare Access. After you sign in, this profile enrolls with the gateway."
              : `This installs the client ${importGate === "mtls" ? "certificate" : "service token"} and enrolls this profile with the gateway in the encrypted setup file.`,
            buttons: ["Cancel", "Connect"], defaultId: 0, cancelId: 0 });
          if (confirm.response !== 1) break;
          const settings = getDesktopSettingsService();
          const storage = settings.readSecretStorageState();
          if (!storage.available || !storage.encrypted) throw new Error("Encrypted OS credential storage is required to import a client setup.");
          if (importGate === "oauth") {
            // Sign in before changing any setting: if the person cannot sign
            // in, this profile's federation config is left as it was.
            await getCloudflareAccessSignIn().signIn(bundle.endpoint);
          } else {
            const previous = await settings.resolveFederationCloudflareCredentials();
            // Which two secrets this writes is the whole difference between the
            // credential gates on the client side; the runtime reads one pair or the other.
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
          }
          await settings.writeConfigPatchTargeted({ federation: {
            cloudflareEndpoint: bundle.endpoint,
            cloudflareMtlsEnabled: importGate === "mtls",
            cloudflareAccessServiceAuthEnabled: importGate === "service-token",
            cloudflareAccessOAuthEnabled: importGate === "oauth",
          } });
          await getDesktopFederationRuntime().restart();
          await getDesktopFederationRuntime().importInvite(bundle.invite);
          return describe(importGate === "oauth"
            ? "Signed in and gateway invite imported."
            : "Client credentials installed and gateway invite imported.");
        }
        default: throw new Error("Unknown Cloudflare setup action.");
      }
      return describe();
    } finally { busy = false; }
  });
}
