import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readEvalManagedRuntime } from "../eval-managed-runtime";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("../log", () => ({ getMainLogger: () => ({ error: logError }) }));

const roots: string[] = [];
afterEach(async () => { logError.mockClear(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-eval-runtime-"));
  roots.push(root);
  const version = "0.162.1-pwragent.1";
  const sha256: Record<string, string> = {};
  for (const name of ["codex", "codex-app-server", "codex-code-mode-host"]) {
    const banner = name === "codex" ? "codex-cli" : name;
    const script = `#!/bin/sh\nprintf '%s\\n' '${banner} ${version}'\n`;
    await writeFile(path.join(root, name), script, { mode: 0o755 });
    sha256[name] = createHash("sha256").update(script).digest("hex");
  }
  const manifest = path.join(root, "runtime.json");
  await writeFile(manifest, JSON.stringify({ directory: root, version, sha256 }));
  return { root, manifest, env: { PWRAGENT_DEV_EVAL_RUNTIME_MANIFEST: manifest } };
}
describe.skipIf(process.platform === "win32")("eval managed runtime pin", () => {
  it("does nothing for ordinary app startup", async () => {
    expect(await readEvalManagedRuntime(false, {})).toBeUndefined();
  });
  it("validates all executable hashes and real version banners without provider calls", async () => {
    const f = await fixture();
    const runtime = await readEvalManagedRuntime(false, f.env);
    expect(runtime?.command).toBe(path.join(f.root, "codex"));
    expect(runtime?.metadata.version).toBe("0.162.1-pwragent.1");
  });
  it("ignores packaged overrides without reading them, allowing normal runtime fallback", async () => {
    const f = await fixture();
    await writeFile(f.manifest, "invalid JSON must not be read");
    for (const value of ["/missing", f.manifest, ""]) {
      const fallback = vi.fn(async () => "normal managed runtime");
      const runtime = await readEvalManagedRuntime(true, { PWRAGENT_DEV_EVAL_RUNTIME_MANIFEST: value }) ?? await fallback();
      expect(runtime).toBe("normal managed runtime");
      expect(fallback).toHaveBeenCalledOnce();
    }
    expect(logError).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledWith("Ignoring PWRAGENT_DEV_EVAL_RUNTIME_MANIFEST in a packaged application");
  });
  it("rejects tampering in a sibling helper, not just the CLI", async () => {
    const f = await fixture();
    await writeFile(path.join(f.root, "codex-code-mode-host"), "#!/bin/sh\nexit 0\n");
    await expect(readEvalManagedRuntime(false, f.env)).rejects.toThrow("hash mismatch");
  });
  it("rejects a missing executable before returning a managed runtime", async () => {
    const f = await fixture();
    await rm(path.join(f.root, "codex-app-server"));
    await expect(readEvalManagedRuntime(false, f.env)).rejects.toThrow();
  });
});
