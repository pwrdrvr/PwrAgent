import { dialog, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import type { CloudflareSetupRequest, CloudflareSetupStatus } from "@pwragent/shared";
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
import { CLOUDFLARE_LINKS, cloudflareTokenTemplateUrl, resolveCloudflareLink } from "../federation/cloudflare-links";
import { compareCloudflaredVersions, createCloudflaredReleaseCheck } from "../federation/cloudflared-release";
import { getCloudflareAccessSignIn } from "../federation/cloudflare-access-sign-in";
import { CloudflareSignInCancelledError } from "../federation/cloudflare-access-oauth";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getMainLogger } from "../log";
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
  revokeEnrollment: (enrollmentId) => getDesktopFederationRuntime().revokeEnrollment(enrollmentId),
});

const log = getMainLogger("pwragent:federation-cloudflare");
let busy = false;

/** The pane shows each failed check; the log keeps why, for a report after the fact. */
function logFailedChecks(run: string, checks: CloudflareSetupStatus["checks"]): void {
  for (const check of checks ?? []) {
    if (!check.passed) log.info("Cloudflare endpoint check failed", { run, check: check.label, detail: check.detail });
  }
}
const latestCloudflared = createCloudflaredReleaseCheck();

/**
 * A lookup's answer if it arrives within 750 ms, else undefined. The release
 * check can take its whole 4-second timeout on a slow network, and a status
 * read must not wait on GitHub; a lookup still running lands in the check's
 * cache for the next read.
 */
async function briefly<T>(lookup: Promise<T | undefined>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 750); });
  try { return await Promise.race([lookup, late]); } finally { clearTimeout(timer); }
}

/**
 * The gateway setup plus what only this profile knows: the unsaved draft, the
 * installed connector's version and any newer release, and, when this instance
 * connects through a sign-in endpoint, its own sign-in.
 */
async function describe(message?: string, options: { refreshConnector?: boolean } = {}): Promise<CloudflareSetupStatus> {
  // "Check again" looks for the connector now, installed or not; otherwise a
  // lookup from the last 30 seconds answers.
  if (options.refreshConnector) await cloudflareConnector.version({ refresh: true }).catch(() => undefined);
  const status = await setup.status();
  const draft = await loadCloudflareSetupDraft().catch(() => undefined);
  const federation = getDesktopSettingsService().readFederationConfig();
  const endpoint = federation.cloudflareEndpoint?.trim();
  const signIn = federation.cloudflareAccessOAuthEnabled && endpoint
    ? await getCloudflareAccessSignIn().status(endpoint)
    : undefined;
  const clientConnection = endpoint ? getDesktopFederationRuntime().cloudflareClientConnection(endpoint) : undefined;
  const signInPending = getCloudflareAccessSignIn().pending() || undefined;
  const connectorVersion = status.connectorInstalled
    ? await cloudflareConnector.version().catch(() => undefined)
    : undefined;
  const latest = connectorVersion ? await briefly(latestCloudflared()) : undefined;
  const connectorUpdate = connectorVersion && latest && compareCloudflaredVersions(latest, connectorVersion) === 1
    ? latest
    : undefined;
  const connectorHealth = await cloudflareConnector.health();
  const gatewayListening = status.listenPort !== undefined
    && getDesktopFederationRuntime().loopbackListenPort() === status.listenPort;
  return {
    ...status, connectorVersion, connectorUpdate, connectorHealth, gatewayListening, draft, signIn, clientConnection, signInPending,
    ...(message ? { message } : {}),
  };
}

/** The client's connection through `endpoint` once it settles, or its state after ten seconds. */
async function awaitCloudflareConnection(endpoint: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const connection = getDesktopFederationRuntime().cloudflareClientConnection(endpoint);
    if (connection.state === "connected" || connection.state === "rejected" || Date.now() >= deadline) return connection;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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
    if (request.action === "status") return describe(undefined, { refreshConnector: request.refresh === true });
    // Outside the latch: it exists to release a sign-in that holds it.
    if (request.action === "cancel-sign-in") {
      getCloudflareAccessSignIn().cancel();
      return describe();
    }
    // Also outside it: the sign-in it resumes is what holds the latch.
    if (request.action === "reopen-sign-in") {
      return describe(await getCloudflareAccessSignIn().reopen()
        ? "Sign-in page reopened in your browser."
        : "No sign-in is waiting. Choose Sign in, or open the client setup file again.");
    }
    // Also outside it: reference links stay usable while an operation runs —
    // reading the docs mid-setup, or while a sign-in waits, is what they are for.
    if (request.action === "open-link") {
      const template = Object.prototype.hasOwnProperty.call(CLOUDFLARE_LINKS, request.link)
        ? CLOUDFLARE_LINKS[request.link]
        : undefined;
      if (!template) throw new Error("Unknown Cloudflare reference link.");
      const state = await loadCloudflareSetup().catch(() => undefined);
      const status = await setup.status().catch(() => undefined);
      const draft = await loadCloudflareSetupDraft().catch(() => undefined);
      await shell.openExternal(resolveCloudflareLink(template, {
        accountId: state?.accountId ?? status?.accountId ?? draft?.accountId,
        zoneId: state?.zoneId ?? status?.zoneId ?? draft?.zoneId,
        applicationId: state?.applicationId ?? status?.applicationId,
      }));
      return describe();
    }
    if (busy) throw new Error("A Cloudflare setup operation is already running.");
    busy = true;
    try {
      switch (request.action) {
        case "token-link": {
          const current = await loadCloudflareSetup().catch(() => undefined);
          const draft = await loadCloudflareSetupDraft().catch(() => undefined);
          await shell.openExternal(cloudflareTokenTemplateUrl(
            [current?.accountId, request.accountId, draft?.accountId],
            [current?.zoneId, request.zoneId, draft?.zoneId],
          ));
          break;
        }
        case "install-link":
          await shell.openExternal("https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/");
          break;
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
          // Name what was deleted. A setup that stopped before publishing never
          // owned the hostname, which may be another profile's live endpoint.
          return describe(published
            ? `${hostname} is no longer published. Deleted in Cloudflare: ${resources.join(", ")}.`
            : resources.length
              ? `Deleted what this setup had created in Cloudflare: ${resources.join(", ")}. Nothing else changed.`
              : "Cleared this profile's setup. Nothing had been created in Cloudflare.");
        }
        case "set-emails":
          await setup.setEmails(request.emails);
          return describe("Sign-in allowlist updated. A removed person's PwrAgent disconnects at its next access refresh, within 15 minutes.");
        case "audit": logFailedChecks("audit", await setup.audit()); break;
        case "validate":
          await setup.validate();
          logFailedChecks("validation", (await setup.status()).checks);
          break;
        case "start": await setup.start(); break;
        case "stop": await setup.stop(); break;
        case "revoke-client":
          return describe(await setup.revoke(request.id)
            ? "Client revoked. Cloudflare no longer admits its credential, and the federation peer its setup file enrolled was revoked, which ends its session."
            : "Client revoked. Cloudflare no longer admits its credential. PwrAgent has no record of the peer its setup file enrolled, so a session already open continues until you revoke that peer under Federation Instances.");
        case "sign-in": {
          try {
            await getCloudflareAccessSignIn().signIn(signInEndpoint());
          } catch (error) {
            // Cancelling is an outcome, not a failure: nothing was saved.
            if (error instanceof CloudflareSignInCancelledError) return describe("Sign-in cancelled. Your previous sign-in is unchanged.");
            throw error;
          }
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
          if (client) await setup.recordEnrollment(client.id, generated.enrollmentId);
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
            try {
              await getCloudflareAccessSignIn().signIn(bundle.endpoint);
            } catch (error) {
              if (error instanceof CloudflareSignInCancelledError) return describe("Sign-in cancelled. Nothing on this profile changed.");
              throw error;
            }
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
          // Say whether it worked, not only that the file was read: enrollment
          // happens on the first connection, so wait briefly for it.
          const connection = await awaitCloudflareConnection(bundle.endpoint);
          return describe(connection.state === "connected"
            ? `Connected to ${connection.gateway ?? "the gateway"} through ${host}.`
            : `Setup imported, but not connected to ${host} yet${connection.detail ? `: ${connection.detail}` : "."}`);
        }
        default: throw new Error("Unknown Cloudflare setup action.");
      }
      return describe();
    } finally { busy = false; }
  });
}
