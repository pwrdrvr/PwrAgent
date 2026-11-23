import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../", import.meta.url));
const directories = [];
const env = { ...process.env, GOMAXPROCS: "2" };

function put(root, path, value) {
  const filename = join(root, path);
  mkdirSync(dirname(filename), { recursive: true });
  writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pwragent-typecheck-")));
  directories.push(root);
  mkdirSync(join(root, "scripts"));
  for (const script of ["typecheck.mjs", "typecheck-cache.mjs"]) {
    const source = join(repository, "scripts", script);
    if (existsSync(source)) copyFileSync(source, join(root, "scripts", script));
  }
  mkdirSync(join(root, "node_modules"));
  symlinkSync(realpathSync(join(repository, "node_modules/typescript-native")), join(root, "node_modules/typescript-native"), "junction");
  put(root, "package.json", {});
  put(root, "apps/desktop/package.json", {});
  put(root, "apps/desktop/empty.ts", "export {};\n");
  for (const name of ["production", "tests", "renderer"]) {
    put(root, `apps/desktop/tsconfig.${name}.json`, {
      files: ["empty.ts"], compilerOptions: { noEmit: true, types: [] },
    });
  }
  return root;
}

function run(root, script, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root, encoding: "utf8", env, timeout: 10_000,
  });
  if (result.error) throw result.error;
  return result;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it.each([
  ["workspace", "a direct dependency"],
  ["package", "a direct dependency"],
  ["workspace", "a transitive dependency from a new install"],
])("warm %s checks agree with fresh checks after relinking %s", (scope, relink) => {
  const root = fixture();
  const consumer = join(root, "packages/consumer");
  const typecheck = JSON.parse(readFileSync(join(repository, "packages/shared/package.json"), "utf8")).scripts.typecheck;
  put(consumer, "package.json", { dependencies: { "fixture-dep": "*" } });
  put(root, "tsconfig.typecheck.json", { files: [], references: [{ path: "./packages/consumer" }] });
  put(consumer, "tsconfig.json", {
    compilerOptions: {
      strict: true,
      types: [],
      module: "ESNext",
      moduleResolution: "Bundler",
      composite: true,
      emitDeclarationOnly: true,
      rootDir: ".",
      outDir: "node_modules/.cache/pwragent-typecheck",
      tsBuildInfoFile: "node_modules/.cache/pwragent-typecheck/tsconfig.tsbuildinfo",
    },
    files: ["index.ts"],
  });
  put(consumer, "index.ts", 'import { value } from "fixture-dep";\nconst expected: number = value;\n');
  const transitive = relink.startsWith("a transitive");
  const store = join(root, "node_modules", transitive ? ".fixture-store" : ".pnpm");
  for (const kind of ["number", "string"]) {
    put(store, `${kind}/node_modules/fixture-dep/package.json`, { types: "index.d.ts" });
    put(store, `${kind}/node_modules/fixture-dep/index.d.ts`, `export declare const value: ${kind};\n`);
  }
  let link = join(consumer, "node_modules/fixture-dep");
  mkdirSync(dirname(link));
  if (transitive) {
    put(root, "node_modules/.modules.yaml", { virtualStoreDir: ".fixture-store" });
    const bridge = join(store, "bridge/node_modules/fixture-dep");
    put(bridge, "package.json", { types: "index.d.ts" });
    put(bridge, "index.d.ts", 'export { value } from "fixture-types";\n');
    symlinkSync(bridge, link, "junction");
    link = join(dirname(bridge), "fixture-types");
  }
  const check = scope === "workspace"
    ? () => run(root, "scripts/typecheck.mjs")
    : () => run(consumer, ...typecheck.split(" ").slice(1));
  for (const kind of ["number", "string", "number"]) {
    rmSync(link, { force: true });
    symlinkSync(join(store, `${kind}/node_modules/fixture-dep`), link, "junction");
    if (transitive) put(store, "lock.yaml", `fixture-types: ${kind}\n`);
    const warm = check();
    const fresh = run(root, "node_modules/typescript-native/bin/tsc", "--build", "packages/consumer", "--force");
    expect(fresh.status === 0, fresh.stdout + fresh.stderr).toBe(kind === "number");
    expect(warm.status === 0, warm.stdout + warm.stderr).toBe(fresh.status === 0);
    if (kind === "string") expect(warm.stdout).toContain("TS2322");
  }
});

it.each(["--watch", "-w", "--WATCH"])("desktop %s selects the same files as the full desktop project", (flag) => {
  const root = fixture();
  const files = ["src/main.ts", "src/main.test.ts", "src/renderer/view.ts", "e2e/window.ts"];
  for (const filename of files) put(root, `apps/desktop/${filename}`, "export {};\n");
  put(root, "apps/desktop/tsconfig.json", { files, compilerOptions: { noEmit: true, types: [] } });
  const oracle = run(root, "node_modules/typescript-native/bin/tsc", "--project", "apps/desktop/tsconfig.json", "--showConfig");
  const wrapped = run(root, "scripts/typecheck.mjs", "--desktop", flag, "--showConfig");
  expect(oracle.status, oracle.stdout + oracle.stderr).toBe(0);
  expect(wrapped.status, wrapped.stdout + wrapped.stderr).toBe(0);
  expect(JSON.parse(wrapped.stdout).files).toEqual(JSON.parse(oracle.stdout).files);
});
