import fs from "node:fs";
import path from "node:path";
import { build, type Plugin } from "esbuild";
import ts from "typescript";
import { expect, it } from "vitest";
import { headlessEntries } from "../../../scripts/build-headless.mjs";

const desktop = path.resolve(import.meta.dirname, "../../..");
const main = path.join(desktop, "src/main");
const accessMarker = "__PWRAGENT_OWNER_GETTER_ORACLE__";
const entries = [
  "src/main/index.ts",
  "src/main/state/storage-maintenance-worker.ts",
  "src/main/claude/claude-session-reader-worker.ts",
  "src/main/mcp-connections/mcp-connection-bridge-entry.ts",
  "src/main/token-miser/token-miser-hook-entry.ts",
  "src/preload/entry.ts",
  "src/preload/storage-maintenance.ts",
  "src/renderer/index.html",
  "src/renderer/storage-maintenance.html",
];
const worker = "src/renderer/src/features/thread-detail/image-diff/pixel-diff.worker.ts";

function source(file: string, text = fs.readFileSync(file, "utf8")): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}
function walkFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "out", ".local", "__tests__", "e2e", "eval"].includes(entry.name)) return [];
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? walkFiles(file) : /\.[cm]?[jt]sx?$/.test(file) && !/\.test\.|\.d\.[cm]?ts$/.test(file) ? [file] : [];
  });
}

// Instrument the actual loud getters, not their import sites. Tree shaking must
// remove every marker from an owner-free entry, even when access would happen
// only in a future worker message/callback. Never execute a production worker.
function instrumentOwnerGetters(file: string, text: string): string {
  const parsed = source(file, text);
  const insertions: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text.startsWith("get") && node.body
      && node.body.getText(parsed).includes("before startOwnerServices")) {
      insertions.push(node.body.getStart(parsed) + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  for (const offset of insertions.sort((a, b) => b - a)) {
    text = `${text.slice(0, offset)}globalThis.${accessMarker}?.();${text.slice(offset)}`;
  }
  return text;
}
function oraclePlugin(): Plugin {
  return {
    name: "production-owner-getter-oracle",
    setup(builder) {
      builder.onResolve({ filter: /^@renderer\// }, (args) => ({ path: path.join(desktop, "src/renderer/src", args.path.slice("@renderer/".length)) }));
      // Assets and third-party packages cannot import desktop owner modules.
      // Vite's worker wrapper is data here; the worker itself has its own case.
      builder.onResolve({ filter: /\.(?:css|svg|png|webp|jpg|woff2?|wasm)(?:\?.*)?$|\?(?:raw|url|worker)/ }, () => ({ external: true }));
      builder.onLoad({ filter: /\.[cm]?tsx?$/ }, (args) => ({
        contents: instrumentOwnerGetters(args.path, fs.readFileSync(args.path, "utf8")),
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      }));
    },
  };
}
async function bundle(entry: string, extraSource?: string): Promise<string> {
  const result = await build({
    ...(extraSource === undefined ? { entryPoints: [path.join(desktop, entry)] } : {
      stdin: { contents: extraSource, resolveDir: main, sourcefile: "negative-entry.ts", loader: "ts" },
    }),
    bundle: true, write: false, treeShaking: true, platform: "node", format: "esm",
    packages: "external", logLevel: "silent", plugins: [oraclePlugin()],
  });
  return result.outputFiles.map((output) => output.text).join("\n");
}

it("covers every configured production entry and every inline worker", () => {
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
  const otherWorkerDeclarations: string[] = [];
  for (const file of walkFiles(path.join(desktop, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    if (/new\s+(?:Shared)?Worker\s*\(|\.addModule\s*\(/.test(text)) otherWorkerDeclarations.push(file);
    for (const match of text.matchAll(/from\s+["']([^"']+\?worker[^"']*)["']/g)) {
      const candidate = path.resolve(path.dirname(file), match[1].split("?")[0]);
      workers.push(path.relative(desktop, fs.existsSync(candidate) ? candidate : `${candidate}.ts`).replaceAll(path.sep, "/"));
    }
  }
  expect(workers).toEqual([worker]);
  expect(otherWorkerDeclarations).toEqual([]);
  expect(walkFiles(desktop).filter((file) => file.endsWith("electron.vite.config.ts")))
    .toEqual([path.join(desktop, "electron.vite.config.ts")]);
  // The Node host boots the real owner graph in headless-host.boot.oracle.test.
  // Its four leaf workers use the same owner-free sources checked below.
  expect(Object.values(headlessEntries).sort()).toEqual([
    "src/main/headless/index.ts",
    ...entries.slice(1, 5),
  ].sort());
  // A newly introduced bundler must enter this inventory rather than escaping it.
  const otherBuilders = walkFiles(desktop).filter((file) => /(?:from\s*["']esbuild["']|import\(["']esbuild["']\))/.test(fs.readFileSync(file, "utf8")));
  expect(otherBuilders).toEqual([path.join(desktop, "scripts/build-headless.mjs")]);
});

for (const entry of [...entries.filter((entry) => entry !== "src/main/index.ts"), worker]) {
  it(`${entry} retains no owner getter in its executable bundle`, async () => {
    const script = entry.endsWith(".html")
      ? fs.readFileSync(path.join(desktop, entry), "utf8").match(/<script\s+type="module"\s+src="([^"]+)"/)?.[1]
      : undefined;
    if (entry.endsWith(".html") && !script) throw new Error(`Missing renderer entry: ${entry}`);
    const input = script ? `src/renderer${script}` : entry;
    expect(await bundle(input)).not.toContain(accessMarker);
  });
}

it("desktop has no executable file-key encryptor", async () => {
  const keyFilename = "headless-secret.key";
  expect(await bundle("src/main/index.ts")).not.toContain(keyFilename);
  expect(await bundle("", 'import { createFileKeyEncryption } from "./headless/file-key-encryption"; createFileKeyEncryption("state");'))
    .toContain(keyFilename);
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

it("detects owner access deferred until a worker message, including host ports", async () => {
  for (const access of [
    'import { getDesktopBackendRegistry } from "./app-server/backend-registry"; globalThis.onmessage = () => getDesktopBackendRegistry();',
    'import { applicationHost } from "./owner-host"; globalThis.onmessage = () => applicationHost.getVersion();',
  ]) {
    expect(await bundle("", access)).toContain(accessMarker);
  }
});
