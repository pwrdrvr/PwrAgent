import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { context, type BuildResult } from "esbuild";
import fc from "fast-check";
import ts from "typescript";
import { expect, inject, it } from "vitest";
import { headlessEntries } from "../../../scripts/build-headless.mjs";
import { requireOracleFixture } from "../../test-setup/oracle-fixture-context";
import {
  accessMarker, bundleProductionEntry, FILE_KEY_NAME, instrumentCandidate, instrumentOwnerGetters, source,
  type BundleCost, type OracleBuildOptions,
} from "./helpers/production-entry-bundle";

const desktop = path.resolve(import.meta.dirname, "../../..");
const main = path.join(desktop, "src/main");
const chromiumTraceUtility = "src/main/shell/diagnostics/chromium-trace-utility.ts";
const sharedMainWorkerEntries = [
  "src/main/state/storage-maintenance-worker.ts",
  "src/main/claude/claude-session-reader-worker.ts",
  "src/main/mcp-connections/mcp-connection-bridge-entry.ts",
  "src/main/token-miser/token-miser-hook-entry.ts",
];
const entries = [
  "src/main/index.ts",
  ...sharedMainWorkerEntries,
  "src/main/diagnostics/chromium-trace-worker.ts",
  chromiumTraceUtility,
  "src/preload/entry.ts",
  "src/preload/storage-maintenance.ts",
  "src/renderer/index.html",
  "src/renderer/storage-maintenance.html",
];
const worker = "src/renderer/src/features/thread-detail/image-diff/pixel-diff.worker.ts";
const audioWorklet = "src/renderer/src/features/composer/dictation-capture.worklet.js";
// The Outpost daemon loads this before the owner starts (sandbox preflight).
const outpostSandboxEntry = "src/main/headless/outpost-codex-sandbox.ts";

function walkFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "out", ".local", "__tests__", "e2e", "eval"].includes(entry.name)) return [];
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(file) : /\.[cm]?[jt]sx?$/.test(file) && !/\.test\.|\.d\.[cm]?ts$/.test(file) ? [file] : [];
  });
}

function audioWorkletEntry(
  file: string,
  call: ts.CallExpression,
  receiver: ts.Expression,
): string | undefined {
  const [asset] = call.arguments;
  if (!ts.isPropertyAccessExpression(receiver) || receiver.name.text !== "audioWorklet"
    || call.arguments.length !== 1 || !asset || !ts.isPropertyAccessExpression(asset) || asset.name.text !== "href") return;

  const url = asset.expression;
  if (!ts.isNewExpression(url) || !ts.isIdentifier(url.expression) || url.expression.text !== "URL"
    || url.arguments?.length !== 2) return;

  const [specifier, base] = url.arguments;
  if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith(".")
    || base?.getText() !== "import.meta.url") return;

  return path.relative(desktop, path.resolve(path.dirname(file), specifier.text.split("?")[0])).replaceAll(path.sep, "/");
}

type BuildOwner = { signal: AbortSignal; onTestFinished(cleanup: () => Promise<void>): void };

async function ownedBuild(owner: BuildOwner, options: OracleBuildOptions): Promise<BuildResult<OracleBuildOptions>> {
  owner.signal.throwIfAborted();
  const opening = context(options);
  let running: Promise<BuildResult<OracleBuildOptions>> | undefined;
  let cleanup: Promise<void> | undefined;
  const dispose = (): Promise<void> => cleanup ??= (async () => {
    const builder = await opening;
    try {
      await builder.cancel();
      await running?.catch(() => {});
    } finally {
      await builder.dispose();
    }
  })();
  // A timed-out callback continues running. The finishing hook must wait for
  // its own native context and plugin callbacks before the next test starts.
  owner.onTestFinished(dispose);
  const abort = (): void => { void dispose().catch(() => {}); };
  owner.signal.addEventListener("abort", abort, { once: true });
  try {
    const builder = await opening;
    owner.signal.throwIfAborted();
    running = builder.rebuild();
    const result = await running;
    owner.signal.throwIfAborted();
    return result;
  } finally {
    owner.signal.removeEventListener("abort", abort);
    await dispose();
  }
}

function bundle(owner: BuildOwner, entry: string, extraSource?: string): Promise<string> {
  return bundleProductionEntry((options) => ownedBuild(owner, options), entry, extraSource);
}

it("covers every configured production entry, inline worker, and audio worklet", () => {
  const started = performance.now();
  const found: string[] = [];
  const config = source(path.join(desktop, "electron.vite.config.ts"));
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(config) === "input" && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        expect(ts.isPropertyAssignment(property)).toBe(true);
        if (!ts.isPropertyAssignment(property) || !ts.isCallExpression(property.initializer)) throw new Error("Unrecognized build entry");
        const value = property.initializer.arguments[1];
        expect(value && ts.isStringLiteral(value)).toBe(true);
        if (value && ts.isStringLiteral(value)) found.push(value.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(config);
  expect(found.sort()).toEqual([...entries].sort());
  const workers: string[] = [];
  const worklets: string[] = [];
  const nodeWorkerLaunchers: string[] = [];
  const otherWorkerDeclarations: string[] = [];
  for (const file of walkFiles(path.join(desktop, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    if (/new\s+(?:Shared)?Worker\s*\(/.test(text)) {
      if (/import\s*\{\s*Worker\s*\}\s*from\s*["']node:worker_threads["']/.test(text)) {
        nodeWorkerLaunchers.push(file);
      } else {
        otherWorkerDeclarations.push(file);
      }
    }
    if (/\.addModule\s*\(/.test(text)) {
      const visitModuleLoads = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && node.expression.name.text === "addModule") {
          const entry = audioWorkletEntry(file, node, node.expression.expression);
          if (entry) worklets.push(entry);
          else otherWorkerDeclarations.push(file);
        }
        ts.forEachChild(node, visitModuleLoads);
      };
      visitModuleLoads(source(file, text));
    }
    for (const match of text.matchAll(/from\s+["']([^"']+\?worker[^"']*)["']/g)) {
      const candidate = path.resolve(path.dirname(file), match[1].split("?")[0]);
      workers.push(path.relative(desktop, fs.existsSync(candidate) ? candidate : `${candidate}.ts`).replaceAll(path.sep, "/"));
    }
  }
  expect(workers).toEqual([worker]);
  expect(worklets).toEqual([audioWorklet]);
  expect(nodeWorkerLaunchers).toEqual([path.join(desktop, chromiumTraceUtility)]);
  expect(otherWorkerDeclarations).toEqual([]);
  expect(walkFiles(desktop).filter((file) => file.endsWith("electron.vite.config.ts")))
    .toEqual([path.join(desktop, "electron.vite.config.ts")]);
  // The Node host boots the real owner graph in headless-host.boot.oracle.test.
  // Its four leaf workers use the same owner-free sources checked below.
  expect(Object.values(headlessEntries).sort()).toEqual([
    "src/main/headless/index.ts",
    outpostSandboxEntry,
    ...sharedMainWorkerEntries,
  ].sort());
  // A newly introduced bundler must enter this inventory rather than escaping it.
  const otherBuilders = walkFiles(desktop).filter((file) => /(?:from\s*["']esbuild["']|import\(["']esbuild["']\))/.test(fs.readFileSync(file, "utf8")));
  expect(otherBuilders).toEqual([path.join(desktop, "scripts/build-headless.mjs")]);
  console.info("production-entry-oracle inventory", JSON.stringify({ wallMs: performance.now() - started }));
});

for (const entry of [...entries.filter((entry) => entry !== "src/main/index.ts"), worker, audioWorklet, outpostSandboxEntry]) {
  it(`${entry} retains no owner getter in its executable bundle`, async (owner) => {
    const script = entry.endsWith(".html")
      ? fs.readFileSync(path.join(desktop, entry), "utf8").match(/<script\s+type="module"\s+src="([^"]+)"/)?.[1]
      : undefined;
    if (entry.endsWith(".html") && !script) throw new Error(`Missing renderer entry: ${entry}`);
    const input = script ? `src/renderer${script}` : entry;
    expect(await bundle(owner, input)).not.toContain(accessMarker);
  });
}

it("the packaged installer cannot reach an owner getter", async (owner) => {
  const packageRoot = path.resolve(desktop, "../../packages/pwragent");
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  expect(metadata.scripts.postinstall).toContain("dist/runtime.json");
  expect(metadata.scripts.postinstall).toContain("./scripts/install.mjs");
  expect(await bundle(owner, "", `import ${JSON.stringify(path.join(packageRoot, "scripts/install.mjs"))};`)).not.toContain(accessMarker);
});

it("desktop has no executable file-key encryptor", async (owner) => {
  expect(requireOracleFixture(inject("desktopEntryHasFileKey"))).toBe(false);
  expect(await bundle(owner, "", 'import { createFileKeyEncryption } from "./headless/file-key-encryption"; createFileKeyEncryption("state");'))
    .toContain(FILE_KEY_NAME);
});

it("instruments every strict process-owner getter", () => {
  const names: string[] = [];
  for (const file of walkFiles(main)) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("before startOwnerServices")) continue;
    const parsed = source(file, text);
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name?.text.startsWith("get") && node.body
        && node.body.getText(parsed).includes("before startOwnerServices")) names.push(node.name.text);
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
  expect(names.sort()).toEqual([
    "getOwnerHostServices", "getDesktopBackendRegistry", "getDesktopAppServerService",
    "getDesktopSettingsService", "getDesktopConfigStore", "getDesktopFederationRuntime",
    "getDesktopMessagingRuntime", "getRuntimeLeaseManager", "getRuntimeMessagingLeaseCoordinator",
    "getRuntimeFederationLeaseCoordinator", "getMcpConnectionGatewayService",
    "getScheduledThreadActionService", "getDesktopAutomationService",
  ].sort());
});

it("detects owner access deferred until a worker message, including host ports", async (owner) => {
  for (const access of [
    'import { getDesktopBackendRegistry } from "./app-server/backend-registry"; globalThis.onmessage = () => getDesktopBackendRegistry();',
    'import { applicationHost } from "./owner-host"; globalThis.onmessage = () => applicationHost.getVersion();',
  ]) {
    expect(await bundle(owner, "", access)).toContain(accessMarker);
  }
});

it("bounds AST work by candidate source while matching the unfiltered instrumenter", () => {
  const snippets = fc.array(fc.constantFrom(
    'export const value = 1;',
    'export function getOrdinary() { return 1; }',
    'export function getStrict() { throw new Error("before startOwnerServices"); }',
    'export function getComment() { /* before startOwnerServices */ return 1; }',
    'export function setStrict() { throw new Error("before startOwnerServices"); }',
    'export const getArrow = () => { throw new Error("before startOwnerServices"); };',
    'export function getNested() { function nested() { throw new Error("before startOwnerServices"); } return nested; }',
  ), { maxLength: 12 });
  const measure = (instrument: typeof instrumentOwnerGetters, text: string) => {
    const cost: BundleCost = { parses: 0, loads: 0, candidates: 0, bytes: 0, inputs: 0, inputBytes: 0, parseMs: 0, loadMs: 0 };
    const output = instrument("generated.ts", text, cost);
    return { output, parses: cost.parses };
  };
  const budget = (instrument: typeof instrumentOwnerGetters) => fc.property(snippets, (parts) => {
    const text = parts.join("\n");
    return measure(instrument, text).parses === Number(text.includes("before startOwnerServices"));
  });
  // Run the same property on the pre-fix implementation: it must fail.
  expect(fc.check(budget(instrumentCandidate), { seed: 3728 }).failed).toBe(true);
  fc.assert(budget(instrumentOwnerGetters), { seed: 3728 });
  fc.assert(fc.property(snippets, (parts) => {
    const text = parts.join("\n");
    expect(measure(instrumentOwnerGetters, text).output).toBe(measure(instrumentCandidate, text).output);
  }));
});

it("drains a cancelled native build and its plugin before its test releases ownership", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const disposed = Promise.withResolvers<void>();
  const controller = new AbortController();
  const cleanups: Array<() => Promise<void>> = [];
  const owner: BuildOwner = { signal: controller.signal, onTestFinished: (cleanup) => { cleanups.push(cleanup); } };
  let pluginActive = false;
  const outcome = ownedBuild(owner, {
    stdin: { contents: "export const value = 1;" }, write: false, logLevel: "silent",
    plugins: [{ name: "cancellation-ownership-oracle", setup(builder) {
      builder.onStart(async () => {
        pluginActive = true;
        started.resolve();
        await release.promise;
        pluginActive = false;
      });
      builder.onDispose(() => disposed.resolve());
    } }],
  }).then(() => "completed", () => "cancelled");
  try {
    await started.promise;
    controller.abort();
    let drained = false;
    const drain = Promise.all(cleanups.map((cleanup) => cleanup())).then(() => { drained = true; });
    await Promise.resolve();
    expect(pluginActive).toBe(true);
    expect(drained).toBe(false);
    release.resolve();
    expect(await outcome).toBe("cancelled");
    await drain;
    await disposed.promise;
    expect(pluginActive).toBe(false);
  } finally {
    release.resolve();
    await outcome;
    await Promise.all(cleanups.map((cleanup) => cleanup()));
  }
});

it("never opens a native context for an already cancelled test", async () => {
  const controller = new AbortController();
  const reason = new Error("test already finished");
  controller.abort(reason);
  let opened = false;
  let registered = false;
  await expect(ownedBuild({
    signal: controller.signal,
    onTestFinished: () => { registered = true; },
  }, {
    stdin: { contents: "export const value = 1;" }, write: false,
    plugins: [{ name: "unreachable-context", setup() { opened = true; } }],
  })).rejects.toBe(reason);
  expect(opened).toBe(false);
  expect(registered).toBe(false);
});
