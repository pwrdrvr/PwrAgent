import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  linuxPasswordStorePath,
  probeSecretServices,
} from "../linux-password-store";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const repoRoot = join(import.meta.dirname, "../../../../../");
const fixture = join(import.meta.dirname, "fixtures", "linux-password-store-electron.cjs");
const source = join(import.meta.dirname, "..", "linux-password-store.ts");
const root = mkdtempSync(join(tmpdir(), "pwragent-secret-store-electron-"));
const bundled = join(root, "linux-password-store.cjs");
const userDataDir = join(root, "user-data");
mkdirSync(userDataDir);
const cipherPath = join(root, "cipher.bin");

const esbuildPackage = readdirSync(join(repoRoot, "node_modules/.pnpm"))
  .find((entry) => entry.startsWith("esbuild@"));
if (!esbuildPackage) {
  throw new Error("esbuild is not installed");
}
const esbuildBinary = join(
  repoRoot,
  "node_modules/.pnpm",
  esbuildPackage,
  "node_modules/esbuild/bin/esbuild",
);
const bundledBuild = spawnSync(esbuildBinary, [
  source,
  "--bundle",
  "--platform=node",
  "--format=cjs",
  `--outfile=${bundled}`,
], {
  cwd: repoRoot,
  encoding: "utf8",
});
if (bundledBuild.status !== 0) {
  throw new Error(bundledBuild.stderr || bundledBuild.stdout || "esbuild failed");
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const secretsAvailable = (() => {
  const probe = probeSecretServices();
  return probe.status === "ok"
    && (probe.owned.includes("org.freedesktop.secrets")
      || probe.activatable.includes("org.freedesktop.secrets"));
})();

type ProbeResult = {
  selected: string | null;
  backend: string;
  available: boolean;
  roundtrip: string | null;
  restarted: string | null;
};

function launch(env: Record<string, string | undefined>): ProbeResult {
  const resultPath = join(root, `result-${process.hrtime.bigint()}.json`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.PWRAGENT_LINUX_PASSWORD_STORE;
  delete childEnv.PWRAGENT_E2E;
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electronBinary, [fixture, `--user-data-dir=${userDataDir}`], {
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...childEnv,
      ...env,
      PWRAGENT_SECRET_STORE_USER_DATA: userDataDir,
      PWRAGENT_SECRET_STORE_RESULT: resultPath,
      PWRAGENT_SECRET_STORE_MODULE: bundled,
    },
  });
  if (child.error) {
    throw child.error;
  }
  if (child.status !== 0) {
    throw new Error(
      `electron exited ${child.status}: ${child.stderr || child.stdout}`,
    );
  }
  return JSON.parse(readFileSync(resultPath, "utf8")) as ProbeResult;
}

describe("linux password store inside Electron", () => {
  it.skipIf(!secretsAvailable)(
    "uses a remembered libsecret store for a later process",
    () => {
      writeFileSync(linuxPasswordStorePath(userDataDir), "gnome-libsecret\n");
      const first = launch({
        PWRAGENT_SECRET_STORE_CIPHER_OUT: cipherPath,
      });
      expect(first.selected).toBe("gnome-libsecret");
      expect(first.backend).toBe("gnome_libsecret");
      expect(first.available).toBe(true);
      expect(first.roundtrip).toBe("pwragent-secret-store");

      const second = launch({
        PWRAGENT_SECRET_STORE_CIPHER_IN: cipherPath,
      });
      expect(second.available).toBe(true);
      expect(second.restarted).toBe("pwragent-secret-store");
    },
    60_000,
  );
});
