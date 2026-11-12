import fs from "node:fs";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import { buildHeadless } from "../../../../scripts/build-headless.mjs";

/** A rewrite that no longer matches its source must fail the build here, not
 * leave the bundle unchanged to fail later with an unrelated runtime error. */
function replaceOnce(file: string, source: string, expected: string, replacement: string): string {
  const count = source.split(expected).length - 1;
  if (count !== 1) {
    throw new Error(`built-owner-fixture: expected exactly one ${JSON.stringify(expected)} in ${file}, found ${count}. Update the fixture rewrite to match the source.`);
  }
  return source.replace(expected, () => replacement);
}

/** Fresh process and module graph, real composition root; only UI and provider
 * boundaries are fixtures. This never launches Electron or an installed agent. */
export async function buildOwnerFixture(directory: string, kind: "desktop" | "headless" = "headless", extraExports = "", transport: "in-process" | "stdio" = "in-process"): Promise<string> {
  const main = path.resolve(import.meta.dirname, "../..");
  const fixture = path.join(main, "__tests__/fixtures/owner-conformance-codex-transport.ts");
  const packageRoot = path.resolve(main, "../../../../packages/pwragent");
  fs.mkdirSync(path.join(directory, "src"), { recursive: true });
  fs.cpSync(path.join(packageRoot, "bin"), path.join(directory, "bin"), { recursive: true });
  for (const name of ["cli", "daemon", "client", "wire", "version", "sandbox-preflight"]) {
    fs.copyFileSync(path.join(packageRoot, `src/${name}.js`), path.join(directory, `src/${name}.js`));
  }
  fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(directory, "package.json"));
  const plugins: Plugin[] = [{ name: "owned-provider-and-ui", setup(builder) {
    if (transport === "in-process") builder.onResolve({ filter: /(?:^|\/)stdio-transport$/ }, () => ({ path: "codex", namespace: "owned-provider" }));
    builder.onLoad({ filter: /.*/, namespace: "owned-provider" }, () => ({ contents: `
      import { appendFileSync, readFileSync } from "node:fs"; import path from "node:path";
      import { OwnerConformanceCodexTransport } from ${JSON.stringify(fixture)};
      export class StdioJsonRpcTransport extends OwnerConformanceCodexTransport {
        constructor(options) { super(); this.launchOptions = options; }
        async connect() {
          await this.launchOptions.resolveCommand?.();
          await super.connect();
        }
        send(message) {
          OwnerConformanceCodexTransport.recordsFile = path.join(process.env.PWRAGENT_TEST_DATA, "fixture-threads.json");
          appendFileSync(path.join(process.env.PWRAGENT_TEST_DATA, "calls.jsonl"), message + "\\n");
          try { OwnerConformanceCodexTransport.helperTitle = JSON.parse(readFileSync(path.join(process.env.PWRAGENT_TEST_DATA, "helper-title.json"), "utf8")).title; }
          catch (error) { if (error.code !== "ENOENT") throw error; }
          super.send(message);
        }
      }`, loader: "ts", resolveDir: main }));
    builder.onLoad({ filter: /headless[\\/]index\.ts$/ }, args => {
      let source = fs.readFileSync(args.path, "utf8");
      if (kind === "desktop") {
        source = replaceOnce(args.path, source, 'import { createHeadlessOwnerHostServices } from "./owner-host-services";',
          'import { createDesktopOwnerHostServices } from "../shell/owner-host-services";');
        source = replaceOnce(args.path, source, 'createHeadlessOwnerHostServices({ runtime, profileDirectory, onQuit: () => signal("owner-request"), runtimePolicy })', "({ ...createDesktopOwnerHostServices(), runtimePolicy })");
      }
      return { contents: source + "\n" + extraExports, loader: "ts" };
    });
    builder.onLoad({ filter: /codex-discovery-coordinator\.ts$/ }, args => ({
      contents: replaceOnce(args.path, fs.readFileSync(args.path, "utf8"), "export class CodexDiscoveryCoordinator", "class FixtureCoordinatorBase") + `
        export class CodexDiscoveryCoordinator extends FixtureCoordinatorBase {
          constructor(options) { super({ ...options, discover: async params => {
            const command = params.configuredCommand ?? process.env.PWRAGENT_CODEX_COMMAND;
            return { selectedCommand: command, selectedSource: "config", candidates: [{ command, source: "config", executable: true, selected: true, version: "0.159.2" }] };
          } }); }
        }`, loader: "ts",
    }));
    if (kind === "desktop") {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: "electron", namespace: "owner-shell-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "owner-shell-fixture" }, () => ({ contents: `
        export const app = { isPackaged: true, getVersion: () => "fixture", getPath: () => process.cwd(), on() {}, once() {} };
        export const BrowserWindow = { getAllWindows: () => [], getFocusedWindow: () => undefined };
        export const nativeImage = {}, dialog = {}, shell = {};
        export const safeStorage = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };`, loader: "js" }));
      builder.onResolve({ filter: /^\.\// }, args => {
        if (args.importer !== path.join(main, "shell/owner-host-services.ts")) return;
        return { path: args.path, namespace: "owner-ui-port" };
      });
      builder.onLoad({ filter: /.*/, namespace: "owner-ui-port" }, () => ({ contents: `
        export const subscribersForChannel = () => [];
        export const createReplayClientsFromEnv = () => undefined;
        export const createOpenThreadInUi = () => async () => undefined;
        export const getDesktopNotificationService = () => new Proxy({}, { get: () => () => {} });
        export const createStorageMaintenanceView = () => { throw new Error("An onboarding-incomplete fixture cannot open maintenance UI"); };
        export const broadcastInboundPreview = () => {}, broadcastManagedRuntimeProgress = () => {}, broadcastManagedGrokSignatureRejection = () => {};
        export const broadcastAgentEvent = () => {}, broadcastCodexEnvironmentSetupProgress = () => {}, broadcastAppearanceChange = () => {}, syncThemedDockIcon = () => {};
        export const requestShowThread = () => {}, requestOpenThreadMaintenance = () => false;
        export const checkForAppUpdatesNow = () => {}, installDownloadedAppUpdate = () => {}, readAppUpdateStatus = () => {}, requestQuit = () => {};
        export const sendStarMapCommand = () => {}, readStarMapView = () => {}, readOperatorFocus = () => {};`, loader: "js" }));
      builder.onResolve({ filter: /acp-instance-discovery$/ }, () => ({ path: "acp", namespace: "no-installed-agents" }));
      builder.onLoad({ filter: /.*/, namespace: "no-installed-agents" }, () => ({ contents: "export const discoverLocalAcpAgentRecords = async () => [];", loader: "js" }));
    }
  } }];
  await buildHeadless({ outputDirectory: path.join(directory, "dist"), plugins });
  const guard = path.join(directory, "guard.cjs");
  await build({ entryPoints: [path.join(main, "__tests__/setup/agent-cli-spawn-guard.ts")], outfile: guard, bundle: true, platform: "node", format: "cjs", logLevel: "silent",
    plugins: [{ name: "process-exit-hooks", setup(builder) {
      builder.onResolve({ filter: /^vitest$/ }, () => ({ path: "hooks", namespace: "child-hooks" }));
      builder.onLoad({ filter: /.*/, namespace: "child-hooks" }, () => ({ contents: 'export const afterEach = () => {}; export const afterAll = fn => process.once("exit", () => { try { fn(); } catch (error) { console.error(error.message); process.exitCode = 1; } });', loader: "js" }));
    } }],
  });
  return guard;
}
