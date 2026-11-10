import path from "node:path";
import { fileURLToPath } from "node:url";
import { configureBundledGit } from "../bundled-git";
import { initializeMainLogger, getMainLogger } from "../log";
import { resolveActiveProfileDir, resolveActiveProfileName, resolveProfileBootDecision } from "../profile";
import { disposeAppState } from "../storage/desktop-state-lifecycle";
import { issueProviderDiscoveryPermit } from "../settings/provider-discovery-permit";
import { readNodeRuntimeMetadata, type NodeRuntimeMetadata } from "../runtime-resources";
import { createHeadlessOwnerHostServices } from "./owner-host-services";
import { startOwnerServices, disposeOwnerServices, disposeOwnerServicesSync, prepareOwnerShutdown } from "../owner-services";

const log = getMainLogger("pwragent:headless");

export async function startHeadlessHost(runtime = readNodeRuntimeMetadata()) {
  if (!runtime) throw new Error("The headless runtime manifest is missing. Run build:headless before starting the Node host.");
  const decision = resolveProfileBootDecision();
  if (decision.kind !== "open") throw new Error("The Node host requires an existing PwrAgent profile. Select it with PWRAGENT_PROFILE or --profile.");
  const profileDirectory = resolveActiveProfileDir();
  initializeMainLogger({ profileName: resolveActiveProfileName(), logDirectory: path.join(profileDirectory, "logs") });
  configureBundledGit(runtime.isPackaged ? runtime.resourcesPath : undefined);
  const shutdown = async (source: string) => {
    prepareOwnerShutdown();
    try { await disposeOwnerServices(source); }
    finally { disposeOwnerServicesSync(); disposeAppState(); }
  };
  const signal = (name: string) => { void shutdown(name).catch((error) => { log.error("headless shutdown failed", error); process.exitCode = 1; }); };
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  process.once("exit", () => { try { disposeOwnerServicesSync(); } finally { disposeAppState(); } });
  const host = createHeadlessOwnerHostServices({ runtime, profileDirectory, onQuit: () => signal("owner-request") });
  try {
    const services = await startOwnerServices(host, { bootMode: "active-profile", startedAt: Date.now() });
    for (const error of await services.settings.readFederationKeyAccessErrors()) {
      log.error("Stored federation private key is unavailable in the headless host", error);
    }
    services.prewarm(issueProviderDiscoveryPermit("startup"));
    log.info("headless owner services started", { version: runtime.version, profile: resolveActiveProfileName() });
    return services;
  } catch (error) {
    await shutdown("headless-startup-failed");
    throw error;
  }
}

function requireRuntime(): NodeRuntimeMetadata {
  const runtime = readNodeRuntimeMetadata();
  if (!runtime) throw new Error("Missing headless runtime manifest; rebuild or reinstall PwrAgent.");
  return runtime;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--version")) {
    process.stdout.write(`${requireRuntime().version}\n`);
  } else {
    void startHeadlessHost(requireRuntime()).catch((error) => {
      log.error("headless owner startup failed", { error: error instanceof Error ? error.message : String(error) });
      process.exitCode = 1;
    });
  }
}
